# Code map

Where each request goes: from a page, through its API call, to the route, the service behind it,
and the tables that service reads and writes. Generated on 2026-09-24 from the source, by pattern
matching: route declarations, SQL table names, and the API functions each page calls. Paths the
client builds at run time show their variable parts as `:x`. It is a snapshot, and goes stale as the code changes.

See `CODE_AUDIT.md` for what the audit found along these paths.

## Routes

217 routes. **Guard** is what the router applies to every route in the file; **Checks** are the
permission bits and authorization helpers named in the handler. Authorization inside a service a
handler calls is not listed here, so an empty column does not mean an unchecked route.

### `server/routes/admin.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/admin/usage` | auth+operator+sudo |  | 39 |
| POST | `/api/admin/usage/prune` | auth+operator+sudo |  | 52 |
| GET | `/api/admin/overview` | auth+operator+sudo |  | 58 |
| PUT | `/api/admin/runtime` | auth+operator+sudo |  | 102 |
| GET | `/api/admin/ai` | auth+operator+sudo |  | 123 |
| POST | `/api/admin/ai/discover` | auth+operator+sudo |  | 124 |
| POST | `/api/admin/ai/unlock` | auth+operator+sudo |  | 125 |
| POST | `/api/admin/maradmins/sync` | auth+operator+sudo |  | 127 |
| POST | `/api/admin/email/test` | auth+operator+sudo |  | 133 |
| POST | `/api/admin/digest/run` | auth+operator+sudo |  | 144 |
| GET | `/api/admin/users` | auth+operator+sudo |  | 146 |
| GET | `/api/admin/units` | auth+operator+sudo |  | 153 |
| POST | `/api/admin/units/:unitId/claim` | auth+operator+sudo |  | 158 |
| GET | `/api/admin/audit` | auth+operator+sudo |  | 171 |
| GET | `/api/admin/backup` | auth+operator+sudo |  | 177 |
| GET | `/api/admin/export` | auth+operator+sudo |  | 189 |
| POST | `/api/admin/import` | auth+operator+sudo |  | 196 |
| POST | `/api/admin/maintenance` | auth+operator+sudo |  | 203 |
| GET | `/api/admin/personnel` | auth+operator+sudo |  | 218 |
| GET | `/api/admin/personnel/divergence` | auth+operator+sudo |  | 222 |
| GET | `/api/admin/personnel/runs` | auth+operator+sudo |  | 226 |
| POST | `/api/admin/personnel/sync` | auth+operator+sudo + rosterBody |  | 235 |
| POST | `/api/admin/personnel/link` | auth+operator+sudo |  | 278 |
| GET | `/api/admin/retention` | auth+operator+sudo |  | 296 |
| PUT | `/api/admin/retention/schedule` | auth+operator+sudo |  | 305 |
| POST | `/api/admin/retention/holds` | auth+operator+sudo |  | 317 |
| DELETE | `/api/admin/retention/holds/:id` | auth+operator+sudo |  | 327 |
| POST | `/api/admin/retention/run` | auth+operator+sudo |  | 336 |
| GET | `/api/admin/privacy/inventory` | auth+operator+sudo |  | 344 |

### `server/routes/auth.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/auth/setup` | public |  | 45 |
| POST | `/api/auth/setup` | public |  | 62 |
| POST | `/api/auth/register` | public |  | 87 |
| POST | `/api/auth/login` | public |  | 114 |
| POST | `/api/auth/login/mfa` | public |  | 145 |
| POST | `/api/auth/passkey/options` | public |  | 181 |
| POST | `/api/auth/passkey/verify` | public |  | 192 |
| POST | `/api/auth/logout` | auth (per route) |  | 205 |
| POST | `/api/auth/sudo` | auth (per route) |  | 214 |
| POST | `/api/auth/forgot` | public |  | 237 |
| GET | `/api/auth/reset` | public |  | 259 |
| POST | `/api/auth/reset` | public |  | 265 |
| GET | `/api/auth/invite` | public |  | 283 |
| POST | `/api/auth/invite/accept` | public |  | 292 |
| POST | `/api/auth/cac` | public |  | 337 |

### `server/routes/correspondence.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/correspondence/contacts` | auth |  | 33 |
| POST | `/api/correspondence/contacts` | auth |  | 37 |
| PUT | `/api/correspondence/contacts/:id` | auth |  | 42 |
| GET | `/api/correspondence/threads` | auth |  | 57 |
| POST | `/api/correspondence/threads` | auth |  | 73 |
| GET | `/api/correspondence/threads/:id` | auth |  | 80 |
| POST | `/api/correspondence/threads/:id/state` | auth |  | 91 |
| POST | `/api/correspondence/threads/:id/messages` | auth |  | 111 |
| POST | `/api/correspondence/threads/:id/links` | auth |  | 117 |
| DELETE | `/api/correspondence/threads/:id/links/:workItemId` | auth |  | 127 |
| GET | `/api/correspondence/items/:id/threads` | auth |  | 132 |
| POST | `/api/correspondence/messages/import` | auth |  | 140 |
| GET | `/api/correspondence/connectors` | auth |  | 158 |
| POST | `/api/correspondence/connectors` | auth |  | 172 |
| GET | `/api/correspondence/connectors/:id/authorization` | auth |  | 180 |
| DELETE | `/api/correspondence/connectors/:id` | auth |  | 185 |
| POST | `/api/correspondence/connectors/:id/sync` | auth |  | 194 |

### `server/routes/demo.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/demo/status` | public |  | 21 |
| POST | `/api/demo/start` | public |  | 27 |
| POST | `/api/demo/persona` | auth (per route) |  | 43 |
| POST | `/api/demo/reset` | auth (per route) |  | 57 |
| GET | `/api/demo/sample.csv` | auth (per route) |  | 69 |

### `server/routes/me.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/me` | auth | COUNSEL, EXPORT_DATA, MANAGE_UNITS | 30 |
| GET | `/api/me/org` | auth |  | 66 |
| PUT | `/api/me/profile` | auth |  | 75 |
| GET | `/api/me/prefs` | auth |  | 104 |
| PUT | `/api/me/prefs` | auth |  | 106 |
| POST | `/api/me/password` | auth |  | 116 |
| GET | `/api/me/export` | auth + requireSudo |  | 136 |
| GET | `/api/me/sessions` | auth |  | 155 |
| POST | `/api/me/sessions/revoke-others` | auth |  | 156 |
| DELETE | `/api/me/sessions/:sid` | auth |  | 161 |
| POST | `/api/me/mfa/totp/start` | auth + requireSudo |  | 170 |
| POST | `/api/me/mfa/totp/confirm` | auth + requireSudo |  | 183 |
| POST | `/api/me/mfa/totp/disable` | auth + requireSudo |  | 200 |
| POST | `/api/me/mfa/recovery/regenerate` | auth + requireSudo |  | 210 |
| GET | `/api/me/passkeys` | auth |  | 223 |
| POST | `/api/me/passkeys/options` | auth + requireSudo |  | 224 |
| POST | `/api/me/passkeys` | auth + requireSudo |  | 225 |
| DELETE | `/api/me/passkeys/:id` | auth + requireSudo |  | 234 |
| GET | `/api/me/readiness` | auth |  | 244 |
| PUT | `/api/me/readiness` | auth |  | 245 |
| GET | `/api/me/readiness/:id` | auth | detailUnitsFor | 253 |
| GET | `/api/me/notifications` | auth |  | 266 |
| PUT | `/api/me/notifications/:id/read` | auth |  | 272 |
| POST | `/api/me/notifications/read-all` | auth |  | 277 |
| GET | `/api/me/audit` | auth |  | 283 |
| GET | `/api/me/digest/preview` | auth |  | 289 |
| POST | `/api/me/digest/send-now` | auth |  | 293 |
| POST | `/api/me/email/verify` | auth + requireSudo |  | 302 |
| POST | `/api/me/email/confirm` | auth |  | 314 |

### `server/routes/misc.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| POST | `/api/events` | auth |  | 37 |
| GET | `/api/events/catalog` | auth | detailUnitsFor | 44 |
| GET | `/api/studio/reports` | auth |  | 87 |
| POST | `/api/studio/reports` | auth |  | 91 |
| GET | `/api/studio/reports/:id` | auth |  | 99 |
| POST | `/api/studio/reports/:id/revisions` | auth |  | 122 |
| GET | `/api/studio/reports/:id/revisions/:revision` | auth |  | 136 |
| GET | `/api/studio/reports/:id/revisions/:revision/export.txt` | auth | VIEW_RECORDS, can, detailUnitsFor | 144 |
| GET | `/api/metrics` | auth |  | 189 |
| GET | `/api/metrics/contributors` | auth |  | 194 |
| GET | `/api/reports` | auth |  | 201 |
| GET | `/api/reports/delta` | auth |  | 207 |
| GET | `/api/reports/analysis` | auth |  | 220 |
| GET | `/api/reports/analysis.pdf` | auth |  | 225 |
| GET | `/api/reports/pdf` | auth |  | 237 |
| GET | `/api/reports/csv` | auth | EXPORT_DATA, can | 252 |
| GET | `/api/ai/status` | auth |  | 267 |
| POST | `/api/ai/assist` | auth |  | 269 |
| GET | `/api/maradmins` | auth |  | 286 |
| PUT | `/api/maradmins/:id/state` | auth |  | 299 |
| GET | `/api/search` | auth |  | 311 |

### `server/routes/org.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| POST | `/api/org/units` | auth |  | 25 |
| PUT | `/api/org/units/:unitId` | auth |  | 29 |
| DELETE | `/api/org/units/:unitId` | auth |  | 30 |
| POST | `/api/org/units/:unitId/owner` | auth |  | 31 |
| GET | `/api/org/units/:unitId/dashboard` | auth | VIEW_MEMBER_DETAIL, VIEW_RECORDS, can | 33 |
| GET | `/api/org/units/:unitId/audit` | auth | VIEW_AUDIT, can | 46 |
| GET | `/api/org/units/:unitId/export` | auth | EXPORT_DATA, can | 57 |
| GET | `/api/org/teams` | auth |  | 75 |
| GET | `/api/org/directory` | auth | MANAGE_MEMBERS, can | 89 |
| POST | `/api/org/units/:unitId/members` | auth | MANAGE_MEMBERS, can | 103 |
| PUT | `/api/org/units/:unitId/members/:userId` | auth | MANAGE_MEMBERS, can | 127 |
| DELETE | `/api/org/units/:unitId/members/:userId` | auth | MANAGE_MEMBERS, can, isUnitOwner | 143 |
| POST | `/api/org/units/:unitId/invites` | auth | MANAGE_MEMBERS, MANAGE_ROLES, can, isUnitOwner | 160 |
| GET | `/api/org/units/:unitId/invites` | auth | MANAGE_MEMBERS, can | 186 |
| DELETE | `/api/org/invites/:id` | auth | MANAGE_MEMBERS, can | 194 |
| GET | `/api/org/roles` | auth | canManageRoleDefinition | 204 |
| POST | `/api/org/roles` | auth |  | 212 |
| PUT | `/api/org/roles/:roleId` | auth |  | 223 |
| DELETE | `/api/org/roles/:roleId` | auth | canManageRoleDefinition | 242 |
| POST | `/api/org/team/:userId/roles` | auth |  | 263 |
| DELETE | `/api/org/team/:userId/roles/:roleId` | auth | MANAGE_ROLES, can, isUnitOwner | 276 |
| GET | `/api/org/team` | auth | COUNSEL, EXPORT_DATA, MANAGE_MEMBERS, MANAGE_ROLES, detailUnitsFor, visibleUserIds | 296 |
| GET | `/api/org/team/:userId` | auth | COUNSEL, MANAGE_MEMBERS, can, detailUnitsFor | 322 |
| PUT | `/api/org/team/:userId/profile` | auth | MANAGE_MEMBERS, can, detailUnitsFor | 356 |
| POST | `/api/org/team/:userId/deactivate` | auth + requireOperator, requireSudo |  | 375 |
| POST | `/api/org/team/:userId/reactivate` | auth + requireOperator, requireSudo |  | 388 |
| POST | `/api/org/team/:userId/reset-mfa` | auth + requireOperator, requireSudo |  | 395 |
| POST | `/api/org/team/:userId/temporary-password` | auth + requireOperator, requireSudo |  | 408 |
| POST | `/api/org/team/:userId/logout` | auth + requireOperator, requireSudo |  | 420 |
| POST | `/api/org/team/:userId/operator` | auth + requireOperator, requireSudo |  | 426 |
| POST | `/api/org/units/:unitId/join-codes` | auth |  | 447 |
| GET | `/api/org/units/:unitId/join-codes` | auth |  | 457 |
| DELETE | `/api/org/units/:unitId/join-codes/:inviteId` | auth |  | 461 |
| GET | `/api/org/join-codes/:code` | auth |  | 467 |
| POST | `/api/org/join-codes/:code/join` | auth |  | 473 |

### `server/routes/people.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/people` | auth |  | 15 |
| PUT | `/api/people/:userId/teams/:unitId` | auth |  | 17 |
| POST | `/api/people/:userId/teams` | auth |  | 22 |
| DELETE | `/api/people/:userId/teams/:unitId` | auth |  | 27 |

### `server/routes/record.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/record/summary` | auth |  | 19 |
| GET | `/api/record/assigned` | auth |  | 23 |
| GET | `/api/record/contributions` | auth |  | 25 |
| GET | `/api/record/drafts` | auth |  | 30 |
| POST | `/api/record/drafts/from-work` | auth |  | 31 |
| PUT | `/api/record/drafts/:id` | auth |  | 35 |
| POST | `/api/record/drafts/:id/save` | auth |  | 36 |
| DELETE | `/api/record/drafts/:id` | auth |  | 37 |
| GET | `/api/record/career` | auth |  | 39 |
| PUT | `/api/record/career/profile` | auth |  | 40 |
| POST | `/api/record/career/steps` | auth |  | 41 |
| PUT | `/api/record/career/steps/:id` | auth |  | 42 |
| DELETE | `/api/record/career/steps/:id` | auth |  | 43 |

### `server/routes/records.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| GET | `/api/records/:table` | auth |  | 25 |
| GET | `/api/records/goals/:id/contributors` | auth |  | 52 |
| POST | `/api/records/activities/import` | auth |  | 57 |
| GET | `/api/records/:table/:id` | auth |  | 61 |
| POST | `/api/records/:table` | auth |  | 69 |
| PUT | `/api/records/:table/:id` | auth |  | 74 |
| DELETE | `/api/records/:table/:id` | auth |  | 79 |
| POST | `/api/records/:table/:id/restore` | auth |  | 84 |
| POST | `/api/records/counselings/:id/acknowledge` | auth | canEdit, canRead | 89 |
| GET | `/api/records/:table/:id/attachments` | auth |  | 126 |
| POST | `/api/records/:table/:id/attachments` | auth |  | 132 |
| GET | `/api/records/:table/:id/attachments/:attachmentId` | auth |  | 154 |
| DELETE | `/api/records/:table/:id/attachments/:attachmentId` | auth |  | 166 |
| GET | `/api/records/:table/:id/comments` | auth |  | 181 |
| POST | `/api/records/:table/:id/comments` | auth |  | 185 |
| PUT | `/api/records/:table/:id/comments/:commentId` | auth |  | 189 |
| DELETE | `/api/records/:table/:id/comments/:commentId` | auth |  | 193 |

### `server/routes/support.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| POST | `/api/public-support/tickets` | public |  | 31 |
| GET | `/api/support/tickets` | auth |  | 57 |
| POST | `/api/support/tickets` | auth |  | 68 |
| GET | `/api/support/tickets/:id` | auth |  | 76 |
| POST | `/api/support/tickets/:id/messages` | auth |  | 80 |
| PATCH | `/api/support/tickets/:id` | auth |  | 92 |

### `server/routes/work.ts`

| Method | Path | Guard | Checks | Line |
|---|---|---|---|---|
| POST | `/api/work/sources` | auth |  | 32 |
| GET | `/api/work/sources` | auth |  | 45 |
| GET | `/api/work/sources/:id` | auth |  | 54 |
| POST | `/api/work/imports/preview` | auth |  | 78 |
| POST | `/api/work/imports` | auth |  | 84 |
| GET | `/api/work/imports` | auth |  | 93 |
| GET | `/api/work/imports/:id` | auth |  | 98 |
| GET | `/api/work/items` | auth |  | 120 |
| POST | `/api/work/items` | auth |  | 140 |
| GET | `/api/work/items/:id` | auth |  | 149 |
| POST | `/api/work/items/:id/claim` | auth |  | 159 |
| POST | `/api/work/items/:id/release` | auth |  | 165 |
| POST | `/api/work/items/:id/assign` | auth |  | 172 |
| PATCH | `/api/work/items/:id` | auth |  | 190 |
| POST | `/api/work/items/:id/actions` | auth |  | 213 |
| GET | `/api/work/workload` | auth |  | 229 |
| GET | `/api/work/procedures` | auth |  | 236 |
| POST | `/api/work/items/:id/entries` | auth |  | 240 |
| POST | `/api/work/items/:id/stage` | auth |  | 247 |
| GET | `/api/work/items/:id/handoff-candidates` | auth |  | 252 |
| POST | `/api/work/items/:id/handoff` | auth |  | 257 |
| POST | `/api/work/items/:id/calculate` | auth |  | 262 |
| POST | `/api/work/items/:id/procedure` | auth |  | 267 |
| GET | `/api/work/views` | auth |  | 274 |
| POST | `/api/work/views` | auth |  | 287 |
| DELETE | `/api/work/views/:id` | auth |  | 293 |

## Server modules → tables

| Module | Reads | Writes |
|---|---|---|
| `scripts/backup.ts` | meta, users | meta |
| `scripts/recover-operator.ts` | recovery_codes, users | recovery_codes, users |
| `scripts/scale-check.ts` | activities | activities, unit_members, units, users |
| `server/app.ts` | ranks | users |
| `server/auth/cac.ts` | personnel_roster, users | users |
| `server/auth/passkeys.ts` | passkeys, users | passkeys |
| `server/auth/sessions.ts` | sessions, tokens, users | sessions, tokens, users |
| `server/auth/tokens.ts` | tokens | tokens |
| `server/authz/scope.ts` | member_roles, roles, unit_members, units, users |  |
| `server/db/index.ts` | meta, roles, units, work_actions, work_items | meta, ranks, roles, work_events, work_items |
| `server/routes/admin.ts` | attachments, audit_log, email_log, passkeys, personnel_sync_runs, ranks, sessions, unit_members, units, users | users |
| `server/routes/auth.ts` | ranks, recovery_codes, roles, units, users | member_roles, recovery_codes, units, users |
| `server/routes/demo.ts` | users |  |
| `server/routes/me.ts` | audit_log, notifications, passkeys, ranks, readiness, recovery_codes, roles, units, users | notifications, readiness, recovery_codes, users |
| `server/routes/misc.ts` | activities, awards, goals, maradmin_user_state, maradmins, ranks, trainings, unit_members, users | maradmin_user_state |
| `server/routes/org.ts` | audit_log, counselings, goals, member_roles, passkeys, ranks, recovery_codes, roles, tasks, tokens, unit_members, units, users | member_roles, passkeys, recovery_codes, roles, tokens, unit_invites, unit_members, users |
| `server/routes/records.ts` | attachments, audit_log | attachments, counselings |
| `server/routes/work.ts` | import_jobs, source_files |  |
| `server/services/ai.ts` | activities, ai_usage_daily, counselings, goals, maradmins, tasks, units | ai_usage_daily |
| `server/services/analytics.ts` | activities, awards, counselings, goals, ranks, readiness, trainings, units, users |  |
| `server/services/audit.ts` | audit_log | audit_log |
| `server/services/cases.ts` | ranks, unit_members, users, work_events | work_events, work_items |
| `server/services/comments.ts` | comments, ranks, users | comments |
| `server/services/connectors.ts` | connectors, thread_messages, threads | connectors, threads |
| `server/services/correspondence.ts` | contacts, thread_links, thread_messages, threads, work_items | contacts, thread_links, thread_messages, threads |
| `server/services/dashboard.ts` | activities, awards, counselings, goals, ranks, readiness, tasks, unit_members, users |  |
| `server/services/demo.ts` | audit_log, demo_workspaces, product_events, units, users | activities, audit_log, career_profiles, career_steps, demo_workspaces, goals, import_jobs, member_roles, notifications, product_events, projects, readiness, source_files, tasks, trainings, units, users, work_events, work_items |
| `server/services/digest.ts` | activities, counselings, goals, maradmins, tasks, users | users |
| `server/services/email.ts` |  | email_log |
| `server/services/exports.ts` | activities, users |  |
| `server/services/holds.ts` | legal_holds |  |
| `server/services/intake.ts` | import_jobs, source_files, work_items | import_jobs, source_files, work_items |
| `server/services/invites.ts` | roles, unit_invites, unit_members | member_roles, unit_invite_uses, unit_invites |
| `server/services/maradmins.ts` | maradmins, users | maradmins |
| `server/services/notifications.ts` | users | notifications |
| `server/services/org.ts` | member_roles, roles, unit_members, units, users, work_items | member_roles, roles, unit_members, units, work_items |
| `server/services/people.ts` | member_roles, passkeys, ranks, roles, tokens, unit_members, units, users | member_roles, roles |
| `server/services/personalExport.ts` | ai_usage_daily, attachments, audit_log, career_profiles, career_steps, comments, email_log, maradmin_user_state, maradmins, member_roles, notifications, ranks, readiness, record_drafts, roles, sessions, unit_members, units, users, work_events |  |
| `server/services/personnel.ts` | personnel_roster, personnel_sync_runs, users | personnel_roster, personnel_sync_runs, users |
| `server/services/posthog.ts` | demo_workspaces, product_events, units, users |  |
| `server/services/record.ts` | career_profiles, career_steps, projects, ranks, readiness, record_drafts, trainings, unit_members, units, users, work_events, work_items | activities, career_profiles, career_steps, record_drafts |
| `server/services/records.ts` | activities, attachments, comments, tasks, units, users | activities, attachments, comments, tasks, work_items |
| `server/services/reportStudio.ts` | ranks, report_drafts, report_revisions, users | report_drafts, report_revisions |
| `server/services/reports.ts` | activities, awards, ranks, trainings, units, users |  |
| `server/services/retention.ts` | disposition_runs, legal_holds, retention_schedules | disposition_runs, legal_holds, retention_schedules |
| `server/services/support.ts` | email_log, support_messages, support_tickets, users | support_messages, support_tickets |
| `server/services/telemetry.ts` |  | product_events |
| `server/services/usage.ts` | product_events | product_events |
| `server/services/work.ts` | projects, ranks, source_files, users, work_actions, work_items, work_views | activities, work_actions, work_items, work_views |

## Route files → services

| Route file | Imports |
|---|---|
| `server/routes/admin.ts` | ai, audit, digest, email, exports, maradmins, org, personnel, privacyInventory, records, retention, telemetry, usage |
| `server/routes/auth.ts` | audit, email, org, telemetry |
| `server/routes/correspondence.ts` | audit, connectors, correspondence |
| `server/routes/demo.ts` | audit, demo, telemetry |
| `server/routes/me.ts` | audit, demo, digest, email, org, people, personalExport, personnel |
| `server/routes/misc.ts` | ai, analytics, analyticsPdf, audit, maradmins, metrics, notifications, pdf, records, reportStudio, reports, telemetry |
| `server/routes/org.ts` | audit, dashboard, email, invites, notifications, org, records |
| `server/routes/people.ts` | people |
| `server/routes/record.ts` | record |
| `server/routes/records.ts` | attachments, audit, comments, goals, records |
| `server/routes/support.ts` | support |
| `server/routes/work.ts` | audit, cases, intake, record, scanner, work |

## Client pages → API

| Page / component | Calls |
|---|---|
| `src/components/AiPanel.tsx` | aiAssist → `POST /api/ai/assist` |
| `src/components/AppShell.tsx` | createRecord → `POST /api/records/:x`; demoPersona → `POST /api/demo/persona`; demoReset → `POST /api/demo/reset`; markAllRead → `POST /api/me/notifications/read-all`; markRead → `PUT /api/me/notifications/:x/read` |
| `src/components/Attachments.tsx` | attachments → `GET /api/records/:x/:x/attachments`; deleteAttachment → `DELETE /api/records/:x/:x/attachments/:x`; uploadAttachment → `POST /api/records/:x/:x/attachments` |
| `src/components/CommandPalette.tsx` | search → `GET /api/search` |
| `src/components/Comments.tsx` | addComment → `POST /api/records/:x/:x/comments`; comments → `GET /api/records/:x/:x/comments`; deleteComment → `DELETE /api/records/:x/:x/comments/:x`; editComment → `PUT /api/records/:x/:x/comments/:x` |
| `src/components/CsvImportDialog.tsx` | importActivities → `POST /api/records/activities/import` |
| `src/components/GovernanceConsole.tsx` | adminPlaceHold → `POST /api/admin/retention/holds`; adminReleaseHold → `DELETE /api/admin/retention/holds/:x`; adminRunDisposition → `POST /api/admin/retention/run${apply `; adminSaveSchedule → `PUT /api/admin/retention/schedule` |
| `src/components/ImportWizard.tsx` | inspectSource → `GET /api/work/sources/:x`; previewImport → `POST /api/work/imports/preview`; runImport → `POST /api/work/imports`; uploadSource → `POST /api/work/sources` |
| `src/components/ProjectWork.tsx` | createWorkItem → `POST /api/work/items`; listWorkItems → `GET /api/work/items` |
| `src/components/SudoDialog.tsx` | sudo → `POST /api/auth/sudo` |
| `src/components/UsageConsole.tsx` | adminUsage → `GET /api/admin/usage` |
| `src/pages/Career.tsx` | acknowledgeCounseling → `POST /api/records/counselings/:x/acknowledge` |
| `src/pages/CareerPlan.tsx` | createCareerStep → `POST /api/record/career/steps`; deleteCareerStep → `DELETE /api/record/career/steps/:x`; saveCareerProfile → `PUT /api/record/career/profile`; updateCareerStep → `PUT /api/record/career/steps/:x` |
| `src/pages/Correspondence.tsx` | addThreadMessage → `POST /api/correspondence/threads/:x/messages`; connectorAuthorization → `GET /api/correspondence/connectors/:x/authorization`; createConnector → `POST /api/correspondence/connectors`; createContact → `POST /api/correspondence/contacts`; createThread → `POST /api/correspondence/threads`; deleteConnector → `DELETE /api/correspondence/connectors/:x`; importEmail → `POST /api/correspondence/messages/import`; setThreadState → `POST /api/correspondence/threads/:x/state`; unlinkThreadWork → `DELETE /api/correspondence/threads/:x/links/:x` |
| `src/pages/Dashboard.tsx` | listWorkItems → `GET /api/work/items` |
| `src/pages/ForcePasswordChange.tsx` | changePassword → `POST /api/me/password` |
| `src/pages/Login.tsx` | acceptInvite → `POST /api/auth/invite/accept`; forgotPassword → `POST /api/auth/forgot`; inviteStatus → `GET /api/auth/invite`; login → `POST /api/auth/login`; loginMfa → `POST /api/auth/login/mfa`; passkeyOptions → `POST /api/auth/passkey/options`; passkeyVerify → `POST /api/auth/passkey/verify`; register → `POST /api/auth/register`; resetPassword → `POST /api/auth/reset`; resetStatus → `GET /api/auth/reset`; runSetup → `POST /api/auth/setup`; setupStatus → `GET /api/auth/setup` |
| `src/pages/Maradmins.tsx` | maradminState → `PUT /api/maradmins/:x/state`; maradmins → `GET /api/maradmins${wait ` |
| `src/pages/MemberDetail.tsx` | grantRole → `POST /api/org/team/:x/roles`; member → `GET /api/org/team/:x`; memberReadiness → `GET /api/me/readiness/:x`; revokeRole → `DELETE /api/org/team/:x/roles/:x`; updateMemberProfile → `PUT /api/org/team/:x/profile` |
| `src/pages/Operator.tsx` | adminAiDiscover → `POST /api/admin/ai/discover`; adminAiUnlock → `POST /api/admin/ai/unlock`; adminAudit → `GET /api/admin/audit`; adminClaimUnit → `POST /api/admin/units/:x/claim`; adminEmailTest → `POST /api/admin/email/test`; adminImport → `POST /api/admin/import`; adminMaintenance → `POST /api/admin/maintenance`; adminOverview → `GET /api/admin/overview`; adminRuntime → `PUT /api/admin/runtime`; adminSyncMaradmins → `POST /api/admin/maradmins/sync`; deactivateMember → `POST /api/org/team/:x/deactivate`; forceLogout → `POST /api/org/team/:x/logout`; reactivateMember → `POST /api/org/team/:x/reactivate`; resetMemberMfa → `POST /api/org/team/:x/reset-mfa`; setOperator → `POST /api/org/team/:x/operator`; temporaryPassword → `POST /api/org/team/:x/temporary-password` |
| `src/pages/People.tsx` | addPersonToTeam → `POST /api/people/:x/teams`; createInvite → `POST /api/org/units/:x/invites`; deactivateMember → `POST /api/org/team/:x/deactivate`; forceLogout → `POST /api/org/team/:x/logout`; reactivateMember → `POST /api/org/team/:x/reactivate`; removePersonFromTeam → `DELETE /api/people/:x/teams/:x`; resetMemberMfa → `POST /api/org/team/:x/reset-mfa`; setOperator → `POST /api/org/team/:x/operator`; setPersonLevel → `PUT /api/people/:x/teams/:x`; temporaryPassword → `POST /api/org/team/:x/temporary-password` |
| `src/pages/Readiness.tsx` | saveReadiness → `PUT /api/me/readiness` |
| `src/pages/RecordDetail.tsx` | attachments → `GET /api/records/:x/:x/attachments`; deleteAttachment → `DELETE /api/records/:x/:x/attachments/:x`; getRecord → `GET /api/records/:x/:x`; uploadAttachment → `POST /api/records/:x/:x/attachments` |
| `src/pages/RecordHub.tsx` | deleteDraft → `DELETE /api/record/drafts/:x`; saveDraftToRecord → `POST /api/record/drafts/:x/save`; updateDraft → `PUT /api/record/drafts/:x` |
| `src/pages/ReportAnalysis.tsx` | reportAnalysis → `GET /api/reports/analysis` |
| `src/pages/ReportStudio.tsx` | createReportDraft → `POST /api/studio/reports`; saveReportRevision → `POST /api/studio/reports/:x/revisions` |
| `src/pages/Reports.tsx` | report → `GET /api/reports`; reportDelta → `GET /api/reports/delta` |
| `src/pages/Settings.tsx` | changePassword → `POST /api/me/password`; digestSendNow → `POST /api/me/digest/send-now`; emailConfirm → `POST /api/me/email/confirm`; emailVerify → `POST /api/me/email/verify`; passkeyDelete → `DELETE /api/me/passkeys/:x`; passkeyRegister → `POST /api/me/passkeys`; passkeyRegisterOptions → `POST /api/me/passkeys/options`; regenerateRecovery → `POST /api/me/mfa/recovery/regenerate`; revokeOtherSessions → `POST /api/me/sessions/revoke-others`; revokeSession → `DELETE /api/me/sessions/:x`; totpConfirm → `POST /api/me/mfa/totp/confirm`; totpDisable → `POST /api/me/mfa/totp/disable`; totpStart → `POST /api/me/mfa/totp/start`; updateProfile → `PUT /api/me/profile` |
| `src/pages/Team.tsx` | addMember → `POST /api/org/units/:x/members`; archiveUnit → `DELETE /api/org/units/:x`; createInvite → `POST /api/org/units/:x/invites`; createRole → `POST /api/org/roles`; createUnit → `POST /api/org/units`; deleteRole → `DELETE /api/org/roles/:x`; directory → `GET /api/org/directory`; listInvites → `GET /api/org/units/:x/invites`; revokeInvite → `DELETE /api/org/invites/:x`; transferOwnership → `POST /api/org/units/:x/owner`; unitAudit → `GET /api/org/units/:x/audit`; unitDashboard → `GET /api/org/units/:x/dashboard${from && to `; unitExport → `GET /api/org/units/:x/export`; updateRole → `PUT /api/org/roles/:x`; updateUnit → `PUT /api/org/units/:x` |
| `src/pages/WorkDetail.tsx` | getRecord → `GET /api/records/:x/:x` |
| `src/pages/WorkItemPage.tsx` | calculateCase → `POST /api:x/calculate`; changeStage → `POST /api:x/stage`; claimWorkItem → `POST /api/work/items/:x/claim`; draftFromWork → `POST /api/record/drafts/from-work`; handOffWork → `POST /api:x/handoff`; handoffCandidates → `GET /api:x/handoff-candidates`; recordEntry → `POST /api:x/entries`; recordWorkAction → `POST /api/work/items/:x/actions`; releaseWorkItem → `POST /api/work/items/:x/release` |
| `src/pages/Workbench.tsx` | claimWorkItem → `POST /api/work/items/:x/claim`; linkThreadWork → `POST /api/correspondence/threads/:x/links`; listWorkItems → `GET /api/work/items`; releaseWorkItem → `POST /api/work/items/:x/release`; saveWorkView → `POST /api/work/views` |
