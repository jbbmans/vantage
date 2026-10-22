/**
 * Every action Vantage writes to the audit trail, and the category it belongs to (ADR-0013). The trail is read in three
 * parts: what people do as themselves and with records, what unit leaders and Unit Instance roles do to run a unit or a
 * Unit Instance, and what Vantage staff and the service itself do. An entry seals its category into the chain when it is
 * written; an entry from before categories derives it from here when it is read.
 *
 * A new action is added here before it is written: the test suite refuses an action this catalogue does not name, and
 * tests/server/auditCatalog.test.ts scans the server and the scripts for every action written, so nothing is missed and
 * nothing is listed that nothing writes.
 */

export const AUDIT_CATEGORIES = ['user', 'unit', 'enterprise'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  user: 'User activity',
  unit: 'Unit administration',
  enterprise: 'Enterprise administration',
};

export const isAuditCategory = (value: unknown): value is AuditCategory => (AUDIT_CATEGORIES as readonly unknown[]).includes(value);

/**
 * Actions whose names are built when they are written, each family spelled out so the catalogue and its test can name
 * every one. The comment on each says where it is built.
 */
export const AUDIT_ACTION_FAMILIES = {
  /** server/routes/auth.ts openSession: the action each way of signing in names (finishSignIn and the OIDC return). */
  sign_in: ['login', 'setup', 'register', 'password_reset_login', 'invite_login', 'demo_start', 'demo_persona'],
  /** server/services/access.ts record: each step of a Vantage support access request, written to both trails. */
  vantage_access: [
    'vantage_access_requested', 'vantage_access_started', 'vantage_access_approved', 'vantage_access_denied',
    'vantage_access_revoked', 'vantage_access_withdrawn', 'vantage_access_ended', 'vantage_access_expired', 'vantage_access_lapsed',
  ],
  /** server/services/organizations.ts setOrgStatus: `organization_${status}`, with active written as restored. */
  organization_status: ['organization_restored', 'organization_suspended', 'organization_archived'],
  /** server/services/unitConfig.ts record: `${kind}_${lifecycle}` for billets, duty types and training requirements. */
  unit_configuration: (['billet', 'duty_type', 'training_requirement'] as const).flatMap((kind) =>
    (['created', 'updated', 'retired', 'restored'] as const).map((step) => `${kind}_${step}`)),
} as const satisfies Record<string, readonly string[]>;

const USER = [
  // Signing in and out, as oneself, and every refusal on the way.
  ...AUDIT_ACTION_FAMILIES.sign_in.filter((a) => a !== 'setup'),
  'logout', 'login_failed', 'self_register', 'recovery_code_used', 'password_reset_requested', 'password_reset', 'invite_accepted',
  'oidc_rejected', 'oidc_provisioned', 'oidc_linked', 'cac_rejected', 'cac_provisioned', 'cac_verified', 'cac_step_up',
  'cac_step_up_refused', 'console_sign_in_refused', 'login_lockout', 'cross_instance_refused', 'unit_invite_redeemed',
  // One's own account and settings.
  'edit_profile', 'email_confirmed', 'export_personal', 'mfa_enabled', 'mfa_disabled', 'passkey_added', 'passkey_removed',
  'password_change', 'recovery_codes_regenerated', 'revoke_sessions', 'digest_sent',
  // Records: entries, files, counselings, comments, and every read of somebody else's.
  'create', 'edit', 'delete', 'restore', 'import', 'list_records', 'view_record', 'view_member', 'view_roster', 'view_personnel',
  'view_readiness', 'view_unit_dashboard', 'view_team_workload', 'acknowledge_counseling', 'counseling_amended', 'upload_attachment',
  'upload_rejected', 'download_attachment', 'delete_attachment', 'comment_added', 'comment_edited', 'comment_deleted',
  'comment_removed_by_moderator', 'export', 'export_csv', 'export_pdf', 'team_message',
  // An entry its owner moved to the record type it belongs in, and a move undone (ADR-0015).
  'record_moved', 'record_move_undone', 'record_kind_confirmed',
  // Reports and the writing assistant.
  'build_report', 'create_report', 'save_report_revision', 'export_report_revision', 'ai_assist', 'ai_assist_failed',
  // Work, cases and correspondence.
  'work_created', 'work_action', 'work_handed_off', 'work_closed', 'work_reopened', 'work_claim_expired',
  'work_claim_released_on_departure', 'procedure_applied', 'procedure_migrated', 'upload_source', 'run_import',
  'create_connector', 'start_connector_authorization', 'authorize_connector', 'disconnect_connector', 'sync_mailbox',
  'create_thread', 'thread_state', 'link_thread', 'import_email',
  // Asking for help, and answering one's own request.
  'support_ticket_raised', 'support_reply_added',
] as const;

const UNIT = [
  // Members, units and unit roles.
  'add_member', 'edit_membership', 'move_member', 'remove_member', 'edit_member_profile', 'create_unit', 'edit_unit',
  'archive_unit', 'transfer_ownership', 'unit_leader_set', 'unit_leader_ended', 'create_role', 'edit_role', 'delete_role', 'grant_role',
  'revoke_role', 'role_expired', 'unit_role_withheld', 'force_logout', 'account_unlock',
  // Personnel records (ADR-0017): responsibilities, and a change made to many Marines at once.
  'add_responsibility', 'end_responsibility', 'personnel_bulk',
  // A refusal at a unit's or a Unit Instance's routes; the platform's own refusals are sealed enterprise.
  'access_denied',
  // Invitations, join codes, account imports and sign-in details.
  'invite_created', 'invite_revoked', 'unit_invite_created', 'unit_invite_revoked', 'accounts_imported', 'account_imported', 'sign_in_details_sent',
  // Unit Instance roles, settings and Vantage access decisions.
  'org_role_granted', 'org_role_revoked', 'org_role_ended', 'org_role_expired', 'org_role_restored', 'organization_updated',
  'removed_from_organization', 'shared_account_notice', 'vantage_access_approved', 'vantage_access_denied', 'vantage_access_revoked',
  // Configuration: billets, duty types and scoring, training, the structure as a file.
  ...AUDIT_ACTION_FAMILIES.unit_configuration, 'duty_types_standard_added', 'unit_settings_updated', 'unit_configuration_imported',
  'unit_configuration_exported', 'duty_scoring_policy_published', 'duty_scoring_policy_withdrawn',
  // The personnel feed.
  'personnel_sync_planned', 'personnel_sync', 'personnel_sync_update', 'personnel_provisioned', 'personnel_profile_updated',
  'personnel_separated', 'personnel_reactivated', 'personnel_restored', 'personnel_link', 'personnel_unlink',
  // Retention, holds and the Unit Instance's own exports.
  'retention_schedule_saved', 'disposition_run', 'legal_hold_placed', 'legal_hold_released', 'organization_export',
  'organization_roster_exported', 'organization_audit_exported',
  // Working the unit's support queue.
  'support_note_added', 'support_ticket_updated',
] as const;

const ENTERPRISE = [
  // Setting the service up, and getting back into it.
  'setup', 'operator_recovery',
  // Unit Instance lifecycle and who runs each one.
  'create_organization', 'organization_created', 'unit_instance_provisioned', ...AUDIT_ACTION_FAMILIES.organization_status,
  'org_owner_named', 'platform_owner_named', 'platform_manager_assigned', 'platform_manager_removed', 'platform_owner_configured',
  // Vantage staff and account support.
  'staff_role_granted', 'staff_role_revoked', 'temporary_password', 'reset_mfa', 'edipi_corrected', 'deactivate_account',
  'reactivate_account', 'vantage_account_support', 'credential_change_requested', 'credential_change_approved',
  'credential_change_denied', 'credential_change_cancelled', 'vantage_access_requested', 'vantage_access_started',
  'vantage_access_withdrawn', 'vantage_access_ended', 'vantage_access_expired', 'vantage_access_lapsed',
  // Settings, sign-in, email, AI and maintenance.
  'edit_configuration', 'oidc_checked', 'email_setup_checked', 'ai_unlocked', 'sync_maradmins', 'maintenance_on',
  'maintenance_off', 'maintenance_task', 'purge_deleted',
  // What the service does to itself: a new build, each schema migration it runs, and what counting rows around them found.
  'release_deployed', 'schema_migrated', 'upgrade_verified', 'upgrade_rows_lost', 'upgrade_failed', 'upgrade_reviewed',
  // Features turned off for one Unit Instance, and given back.
  'instance_feature_withheld', 'instance_feature_restored',
  // Data: backups, archives, restores and the integrity of the trail.
  'backup', 'instance_export', 'instance_import', 'database_restored', 'database_replaced', 'platform_audit_exported',
  'case_history_anchor', 'case_history_anchor_requested', 'audit_chain_anchored', 'audit_anchor_verified',
] as const;

/** The catalogue by category, as written above. An action is in one category only; the test suite holds it to that. */
export const AUDIT_CATALOG_GROUPS: Readonly<Record<AuditCategory, readonly string[]>> = { user: USER, unit: UNIT, enterprise: ENTERPRISE };

const catalogOf = (category: AuditCategory, actions: readonly string[]) => actions.map((a) => [a, category] as const);

/** Every action written today, with its default category. A caller may seal another, as the platform's own callers do. */
export const AUDIT_CATALOG: Readonly<Record<string, AuditCategory>> = Object.freeze(Object.fromEntries([
  ...catalogOf('user', USER), ...catalogOf('unit', UNIT), ...catalogOf('enterprise', ENTERPRISE),
]));

/** Actions an older build wrote and nothing writes now, so their entries still read in a category. */
export const LEGACY_AUDIT_ACTIONS: Readonly<Record<string, AuditCategory>> = Object.freeze({
  claim_unit: 'unit', deactivate_member: 'unit', reactivate_member: 'unit', work_assigned: 'user', prune_events: 'enterprise',
  // Granting and revoking instance-operator authority, before Unit Instances (5.x builds before 2026-10-05).
  grant_operator: 'enterprise', revoke_operator: 'enterprise',
});

/** The default category of an action, or null for one the catalogue does not know. */
export function auditCategoryOf(action: string): AuditCategory | null {
  return Object.hasOwn(AUDIT_CATALOG, action) ? AUDIT_CATALOG[action] : Object.hasOwn(LEGACY_AUDIT_ACTIONS, action) ? LEGACY_AUDIT_ACTIONS[action] : null;
}

/** Every action, current or older, whose default category is this one: how an entry from before categories is filtered. */
export function auditActionsIn(category: AuditCategory): string[] {
  return [...Object.entries(AUDIT_CATALOG), ...Object.entries(LEGACY_AUDIT_ACTIONS)].filter(([, c]) => c === category).map(([a]) => a);
}
