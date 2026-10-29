import type { OrgPermission, PermissionKey, PlatformPermission } from '../../shared/permissions.ts';
import { auditCategoryOf, type AuditCategory } from '../../shared/auditCatalog.ts';

/**
 * The privileged route inventory (ADR-0013): every route that changes something through the Vantage Administrator console
 * (/api/platform), the Unit Manager console (/api/orgs) or the unit administration calls (/api/org), and every route that
 * downloads data in bulk, wherever it is mounted. Each names who may call it, whether the session must have confirmed
 * it is the person (step-up), and what it writes to the audit trail with which category.
 *
 * It describes the routes; it does not decide anything. Authorization stays in the routers and services it names.
 * tests/server/privilegedRoutes.test.ts holds the two together: a route added to one of these routers without an entry
 * here fails it, as does an entry for a route that no longer exists, an action the audit catalogue does not know, or a
 * route an ordinary member can reach.
 *
 * Permissions are any one of those listed: a platform permission (platform.*), a Unit Instance permission (org.*), a unit
 * permission by its PERMISSIONS key, which org.members, org.units and org.roles also confer in every unit of their
 * Unit Instance, 'unit_leader' for the unit's own leader, or 'self' for a signed-in person acting on their own account
 * or records. A refusal at /api/platform, /api/orgs or /api/org is itself written as access_denied (server/app.ts),
 * enterprise at the first and unit at the others, so it is not repeated on each route.
 */

export type RouteAuthority = PlatformPermission | OrgPermission | PermissionKey | 'unit_leader' | 'self';

export interface AuditWrite {
  action: string;
  /** The category the entry is sealed with: the catalogue's default unless the route's caller passes another. */
  category: AuditCategory | null;
}

export interface PrivilegedRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path as mounted, with Express parameters. */
  path: string;
  /** change: a POST, PUT, PATCH or DELETE on an administration router. bulk: a download of many records or the whole service. */
  kind: 'change' | 'bulk';
  permission: readonly RouteAuthority[];
  /** The session must have confirmed the person recently (password, CAC or the organization's sign-in): sudo_required otherwise. */
  stepUp: boolean;
  /** Every action the route can write, including those its services write on its behalf. Empty only with a reason in note. */
  audit: readonly AuditWrite[];
  note?: string;
}

/** The routers this inventory covers, where each is mounted (server/app.ts), and whether every change on it is listed. */
export const PRIVILEGED_ROUTERS = [
  { file: 'server/routes/platform.ts', router: 'platformRouter', mount: '/api/platform', changes: true },
  { file: 'server/routes/orgs.ts', router: 'orgsRouter', mount: '/api/orgs', changes: true },
  { file: 'server/routes/org.ts', router: 'orgRouter', mount: '/api/org', changes: true },
  { file: 'server/routes/me.ts', router: 'meRouter', mount: '/api/me', changes: false },
  { file: 'server/routes/misc.ts', router: 'miscRouter', mount: '/api', changes: false },
  { file: 'server/routes/reportCenter.ts', router: 'reportCenterRouter', mount: '/api/report-center', changes: false },
] as const;

/** A GET whose path reads as a download: an export, a backup, or a file by its extension. Each is listed below or excused here. */
export const DOWNLOAD_PATH = /\/(?:export|backup)(?:[/.]|$)|[/.](?:csv|pdf|zip)$/;

/** Downloads that are not bulk data, and why. */
export const NOT_BULK: ReadonlyArray<{ method: 'GET'; path: string; why: string }> = [
  { method: 'GET', path: '/api/demo/sample.csv', why: 'A fixed sample file for the import dialog. It holds no one’s records.' },
  { method: 'GET', path: '/api/studio/reports/:id/revisions/:revision/export.txt', why: 'One revision of one report its reader may already open. Audited as export_report_revision.' },
  { method: 'GET', path: '/api/records/:table/:id/export', why: 'One record its reader may already open, with its files. Audited as export_record.' },
];

const write = (action: string): AuditWrite => ({ action, category: auditCategoryOf(action) });
/** Actions written with the catalogue's default categories. */
const writes = (...actions: string[]) => actions.map(write);
/** Actions this route's caller seals with another category than the catalogue's default. */
const sealed = (category: AuditCategory, ...actions: string[]): AuditWrite[] => actions.map((action) => ({ action, category }));

type Method = PrivilegedRoute['method'];
const kindOf = (method: Method): PrivilegedRoute['kind'] => (method === 'GET' ? 'bulk' : 'change');

/** The Vantage Administrator console: staff only, and every route behind step-up (the router's own guard). */
const platform = (method: Method, path: string, permission: PlatformPermission, audit: AuditWrite[], note?: string): PrivilegedRoute =>
  ({ method, path: `/api/platform${path}`, kind: kindOf(method), permission: [permission], stepUp: true, audit, ...(note ? { note } : {}) });

/** The Unit Manager console: a Unit Instance permission in the instance the path names, behind step-up past its list. */
const orgs = (method: Method, path: string, permission: OrgPermission[], audit: AuditWrite[], note?: string): PrivilegedRoute =>
  ({ method, path: `/api/orgs${path}`, kind: kindOf(method), permission, stepUp: true, audit, ...(note ? { note } : {}) });

/** Unit administration: a unit permission in the unit the call names, decided in the route or its service. No step-up. */
const unit = (method: Method, path: string, permission: RouteAuthority[], audit: AuditWrite[], note?: string): PrivilegedRoute =>
  ({ method, path: `/api/org${path}`, kind: kindOf(method), permission, stepUp: false, audit, ...(note ? { note } : {}) });

/** What a removal from a unit writes besides its own entry: a leadership it ends, Unit Instance roles, claimed work. */
const DEPARTURE = ['unit_leader_ended', 'org_role_ended', 'work_claim_released_on_departure'];

export const PRIVILEGED_ROUTES: readonly PrivilegedRoute[] = [
  // ——— /api/platform: the service, for Vantage staff ———
  platform('POST', '/sign-in-health/oidc-check', 'platform.settings', writes('oidc_checked')),
  platform('PUT', '/runtime', 'platform.settings', writes('edit_configuration')),
  platform('POST', '/maintenance', 'platform.maintenance', writes('maintenance_on', 'maintenance_off')),
  platform('POST', '/maintenance/tasks/:task', 'platform.maintenance', writes('maintenance_task')),
  platform('POST', '/upgrades/:id/review', 'platform.maintenance', writes('upgrade_reviewed'), 'Only an upgrade that failed or lost rows, once.'),
  platform('PUT', '/orgs/:orgId/features/:flag', 'platform.settings', writes('instance_feature_withheld', 'instance_feature_restored'), 'Only ever turns a feature off for one Unit Instance, or gives it back the service’s setting; its Lead Unit Managers are told.'),
  platform('POST', '/ai/discover', 'platform.ai', [], 'Asks the configured model provider which models it offers. It changes nothing; choosing models is a settings change (PUT /runtime).'),
  platform('POST', '/ai/unlock', 'platform.ai', writes('ai_unlocked')),
  platform('POST', '/maradmins/sync', 'platform.settings', writes('sync_maradmins')),
  platform('POST', '/email/check', 'platform.email', writes('email_setup_checked')),
  platform('POST', '/email/test', 'platform.email', [], 'Sends one test message. The mail log (email_log) records it, not the audit trail.'),
  platform('POST', '/orgs', 'platform.orgs', writes('organization_created')),
  platform('PATCH', '/orgs/:orgId', 'platform.orgs', sealed('enterprise', 'organization_updated')),
  platform('POST', '/orgs/:orgId/status', 'platform.orgs', writes('organization_restored', 'organization_suspended', 'organization_archived')),
  platform('POST', '/orgs/:orgId/owner', 'platform.orgs', writes('org_owner_named', 'platform_owner_named')),
  platform('POST', '/orgs/:orgId/managers', 'platform.managers', [...sealed('enterprise', 'org_role_granted'), ...writes('platform_manager_assigned')]),
  platform('DELETE', '/orgs/:orgId/managers/:userId/:role', 'platform.managers', [...sealed('enterprise', 'org_role_revoked'), ...writes('platform_manager_removed')]),
  platform('POST', '/accounts/:userId/unlock', 'platform.accounts', sealed('enterprise', 'account_unlock')),
  platform('POST', '/accounts/:userId/logout', 'platform.accounts', sealed('enterprise', 'force_logout')),
  platform('POST', '/accounts/:userId/temporary-password', 'platform.accounts', writes('temporary_password', 'vantage_account_support'), 'A second staff member’s approval when the account holds authority.'),
  platform('POST', '/accounts/:userId/reset-mfa', 'platform.accounts', writes('reset_mfa', 'vantage_account_support'), 'A second staff member’s approval when the account holds authority.'),
  platform('POST', '/accounts/:userId/edipi', 'platform.accounts', writes('edipi_corrected', 'vantage_account_support'), 'A second staff member’s approval when the account holds authority.'),
  platform('POST', '/accounts/:userId/deactivate', 'platform.accounts', writes('deactivate_account', 'vantage_account_support')),
  platform('POST', '/accounts/:userId/reactivate', 'platform.accounts', writes('reactivate_account', 'vantage_account_support')),
  platform('POST', '/accounts/:userId/credential-approvals', 'platform.accounts', sealed('enterprise', 'credential_change_requested')),
  platform('POST', '/credential-approvals/:id/approve', 'platform.accounts', sealed('enterprise', 'credential_change_approved'), 'Never by the requester or the account; platform.staff as well when the account is staff.'),
  platform('POST', '/credential-approvals/:id/deny', 'platform.accounts', sealed('enterprise', 'credential_change_denied'), 'Never by the requester or the account; platform.staff as well when the account is staff.'),
  platform('POST', '/credential-approvals/:id/cancel', 'platform.accounts', sealed('enterprise', 'credential_change_cancelled'), 'The requester only.'),
  platform('POST', '/accounts/sign-in-details', 'platform.accounts', sealed('enterprise', 'sign_in_details_sent')),
  platform('POST', '/staff', 'platform.staff', writes('staff_role_granted')),
  platform('DELETE', '/staff/:userId/:role', 'platform.staff', writes('staff_role_revoked')),
  platform('POST', '/access', 'platform.access', writes('vantage_access_requested', 'vantage_access_started')),
  platform('POST', '/access/:id/end', 'platform.access', writes('vantage_access_withdrawn', 'vantage_access_ended'), 'One’s own access; another staff member’s with platform.staff.'),
  platform('POST', '/integrity/anchor', 'platform.settings', writes('case_history_anchor', 'case_history_anchor_requested', 'audit_chain_anchored')),
  platform('POST', '/integrity/verify', 'platform.audit', writes('audit_anchor_verified')),
  platform('POST', '/holds', 'platform.data', sealed('enterprise', 'legal_hold_placed')),
  platform('DELETE', '/holds/:id', 'platform.data', sealed('enterprise', 'legal_hold_released')),
  platform('POST', '/import', 'platform.data', writes('instance_import'), 'Replaces the whole service from an archive; every session ends.'),
  platform('GET', '/audit/export', 'platform.audit', writes('platform_audit_exported')),
  platform('GET', '/backup', 'platform.data', writes('backup'), 'Only while browser backups are allowed; every other holder of platform.data is told.'),
  platform('GET', '/export', 'platform.data', writes('instance_export'), 'Only while browser backups are allowed; every other holder of platform.data is told.'),

  // ——— /api/orgs: one Unit Instance, for the people who hold a role in it ———
  orgs('PATCH', '/:orgId', ['org.settings', 'org.owners'], writes('organization_updated'), 'Renaming takes org.settings; the Vantage access policy takes org.owners.'),
  orgs('POST', '/:orgId/roles', ['org.owners'], writes('org_role_granted'), 'Never one’s own role, nor to an account the granter opened that has not proven itself.'),
  orgs('DELETE', '/:orgId/roles/:userId/:role', ['org.owners'], writes('org_role_revoked'), 'Never the last Lead Unit Manager.'),
  orgs('POST', '/:orgId/members/:userId/unlock', ['org.members'], writes('account_unlock')),
  orgs('POST', '/:orgId/members/:userId/logout', ['org.members'], writes('force_logout', 'shared_account_notice')),
  orgs('DELETE', '/:orgId/members/:userId', ['org.members'], writes('removed_from_organization', ...DEPARTURE)),
  orgs('POST', '/:orgId/accounts/import', ['org.members'], writes('accounts_imported', 'account_imported', 'create_unit', 'unit_role_withheld'), 'Writes only when applied (apply=1); a plan writes nothing.'),
  orgs('POST', '/:orgId/accounts/sign-in-details', ['org.members'], writes('sign_in_details_sent')),
  orgs('POST', '/:orgId/units/:unitId/leader', ['org.units'], writes('unit_leader_set')),
  orgs('POST', '/:orgId/personnel/sync', ['org.personnel'], writes(
    'personnel_sync_planned', 'personnel_sync', 'personnel_sync_update', 'personnel_profile_updated', 'personnel_separated', 'personnel_reactivated',
    'personnel_restored', 'org_role_restored', 'unit_leader_set', ...DEPARTURE,
  ), 'Separating a Unit Instance role holder also takes org.owners.'),
  orgs('POST', '/:orgId/personnel/link', ['org.personnel'], writes('personnel_link', 'personnel_unlink'), 'A Unit Instance role holder’s CAC is org.owners’ to change.'),
  orgs('PUT', '/:orgId/retention/schedule', ['org.retention'], writes('retention_schedule_saved')),
  orgs('POST', '/:orgId/retention/run', ['org.retention'], writes('disposition_run'), 'Writes only when applied (apply=1) and something was disposed of.'),
  orgs('POST', '/:orgId/holds', ['org.holds'], writes('legal_hold_placed')),
  orgs('DELETE', '/:orgId/holds/:id', ['org.holds'], writes('legal_hold_released')),
  orgs('POST', '/:orgId/billets', ['org.config'], writes('billet_created')),
  orgs('PATCH', '/:orgId/billets/:id', ['org.config'], writes('billet_updated', 'billet_retired', 'billet_restored')),
  orgs('POST', '/:orgId/duty-types', ['org.config'], writes('duty_type_created')),
  orgs('POST', '/:orgId/duty-types/standard', ['org.config'], writes('duty_types_standard_added')),
  orgs('PATCH', '/:orgId/duty-types/:id', ['org.config'], writes('duty_type_updated', 'duty_type_retired', 'duty_type_restored')),
  orgs('POST', '/:orgId/error-report-types', ['org.config'], writes('error_report_type_created')),
  orgs('POST', '/:orgId/error-report-types/standard', ['org.config'], writes('error_report_types_standard_added')),
  orgs('PATCH', '/:orgId/error-report-types/:id', ['org.config'], writes('error_report_type_updated', 'error_report_type_retired', 'error_report_type_restored')),
  orgs('POST', '/:orgId/training-requirements', ['org.config'], writes('training_requirement_created')),
  orgs('PATCH', '/:orgId/training-requirements/:id', ['org.config'], writes('training_requirement_updated', 'training_requirement_retired', 'training_requirement_restored')),
  orgs('PATCH', '/:orgId/configuration/settings', ['org.config'], writes('unit_settings_updated')),
  orgs('POST', '/:orgId/duty-scoring', ['org.config'], writes('duty_scoring_policy_published')),
  orgs('POST', '/:orgId/duty-scoring/:id/withdraw', ['org.config'], writes('duty_scoring_policy_withdrawn')),
  orgs('POST', '/:orgId/configuration/import', ['org.config'], writes('unit_configuration_imported'), 'Writes only when applied (apply=1); a plan writes nothing.'),
  orgs('POST', '/:orgId/access/:id/approve', ['org.access'], writes('vantage_access_approved')),
  orgs('POST', '/:orgId/access/:id/deny', ['org.access'], writes('vantage_access_denied')),
  orgs('POST', '/:orgId/access/:id/revoke', ['org.access'], writes('vantage_access_revoked')),
  orgs('GET', '/:orgId/audit/export', ['org.audit'], writes('organization_audit_exported')),
  orgs('GET', '/:orgId/export', ['org.export'], writes('organization_export'), 'Structure only: units, unit roles, members and role holders. No records.'),
  orgs('GET', '/:orgId/roster.csv', ['org.export'], writes('organization_roster_exported'), 'No EDIPI, email address or records.'),
  orgs('GET', '/:orgId/configuration/export', ['org.export'], writes('unit_configuration_exported')),

  // ——— /api/org: units, members and unit roles, decided unit by unit ———
  unit('POST', '/units', ['MANAGE_UNITS'], writes('create_unit', 'create_organization'), 'MANAGE_UNITS in the parent. With no parent it founds a Unit Instance, only while the platform allows self-service Unit Instances (never under MCEN).'),
  unit('PUT', '/units/:unitId', ['MANAGE_UNITS'], writes('edit_unit')),
  unit('DELETE', '/units/:unitId', ['MANAGE_UNITS'], writes('archive_unit', ...DEPARTURE)),
  unit('POST', '/units/:unitId/owner', ['unit_leader', 'org.units'], writes('transfer_ownership')),
  unit('POST', '/units/:unitId/members', ['MANAGE_MEMBERS'], writes('add_member', 'unit_role_withheld'), 'Only Marines the caller already leads in the Unit Instance; anyone else is invited.'),
  unit('PUT', '/units/:unitId/members/:userId', ['MANAGE_MEMBERS'], writes('edit_membership'), 'Billet, primary unit, assignment dates, supervisor and check-in, above the Marine’s position; the Marine’s own billet and primary unit only for themselves (ADR-0017).'),
  unit('POST', '/units/:unitId/members/:userId/responsibilities', ['MANAGE_MEMBERS'], writes('add_responsibility'), 'Above the Marine’s position; never one’s own.'),
  unit('POST', '/responsibilities/:id/end', ['MANAGE_MEMBERS'], writes('end_responsibility'), 'MANAGE_MEMBERS in a unit of the Marine in that Unit Instance, above their position; never one’s own.'),
  unit('POST', '/units/:unitId/personnel/bulk', ['MANAGE_MEMBERS'], writes('personnel_bulk', 'edit_membership', 'add_responsibility', 'move_member', 'work_claim_released_on_departure', 'unit_role_withheld'), 'Every row is decided as its single change would be; a preview or any refused row changes nothing.'),
  unit('POST', '/units/:unitId/message', ['MANAGE_MEMBERS'], writes('team_message')),
  unit('POST', '/units/:unitId/members/:userId/move', ['MANAGE_MEMBERS'], writes('move_member', 'unit_leader_ended', 'work_claim_released_on_departure', 'unit_role_withheld'), 'MANAGE_MEMBERS in both units.'),
  unit('DELETE', '/units/:unitId/members/:userId', ['MANAGE_MEMBERS'], writes('remove_member', ...DEPARTURE)),
  unit('POST', '/units/:unitId/invites', ['MANAGE_MEMBERS'], writes('invite_created')),
  unit('DELETE', '/invites/:id', ['MANAGE_MEMBERS'], writes('invite_revoked')),
  unit('POST', '/roles', ['MANAGE_ROLES'], writes('create_role'), 'Below the caller’s own position and within the permissions they hold, unless they lead the unit or staff it through the Unit Instance.'),
  unit('PUT', '/roles/:roleId', ['MANAGE_ROLES'], writes('edit_role')),
  unit('DELETE', '/roles/:roleId', ['MANAGE_ROLES'], writes('delete_role')),
  unit('POST', '/team/:userId/roles', ['MANAGE_ROLES'], writes('grant_role'), 'Never reach one’s own record-reading authority, nor give it to an account the granter opened that has not proven itself.'),
  unit('DELETE', '/team/:userId/roles/:roleId', ['MANAGE_ROLES'], writes('revoke_role')),
  unit('PUT', '/team/:userId/profile', ['MANAGE_MEMBERS'], writes('edit_member_profile'), 'Kept by the Unit Instance that holds the Marine’s primary unit.'),
  unit('POST', '/units/:unitId/join-codes', ['MANAGE_MEMBERS'], writes('unit_invite_created')),
  unit('DELETE', '/units/:unitId/join-codes/:inviteId', ['MANAGE_MEMBERS'], writes('unit_invite_revoked')),
  unit('POST', '/join-codes/:code/join', ['self'], writes('unit_invite_redeemed', 'unit_role_withheld'), 'Anyone signed in who holds a live join code joins with it; a role it carries from the person who opened the account is held back.'),
  unit('GET', '/units/:unitId/export', ['EXPORT_DATA'], writes('export'), 'The unit’s shared work, beneath it as well. Never private entries.'),

  // ——— Bulk downloads elsewhere: one’s own data, or another Marine’s through a unit permission ———
  { method: 'GET', path: '/api/me/export', kind: 'bulk', permission: ['self'], stepUp: true, audit: writes('export_personal'), note: 'Everything one keeps, or the categories one chooses: JSON, a ZIP with attachments, a workbook, or one category as CSV.' },
  { method: 'GET', path: '/api/reports/csv', kind: 'bulk', permission: ['self', 'EXPORT_DATA'], stepUp: false, audit: writes('export_csv', 'build_report'), note: 'Another Marine’s activities take EXPORT_DATA in the unit as well as opening their record.' },
  { method: 'GET', path: '/api/reports/pdf', kind: 'bulk', permission: ['self', 'VIEW_MEMBER_DETAIL'], stepUp: false, audit: writes('export_pdf', 'build_report') },
  { method: 'GET', path: '/api/reports/analysis.pdf', kind: 'bulk', permission: ['self', 'VIEW_MEMBER_DETAIL'], stepUp: false, audit: writes('export_pdf', 'build_report') },
  {
    method: 'GET', path: '/api/report-center/export', kind: 'bulk', permission: ['self', 'VIEW_MEMBER_DETAIL', 'EXPORT_DATA'], stepUp: false, audit: writes('export_report', 'view_team_workload'),
    note: 'Any report as a PDF, CSV, workbook or JSON (ADR-0020). One’s own in every format; another Marine’s as a PDF by opening their record, otherwise with EXPORT_DATA as well; a unit’s only with EXPORT_DATA there. The workload report writes view_team_workload when it shows Marines.',
  },
];
