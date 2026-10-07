/**
 * The shapes the admin dashboard and the owner console read (ADR-0006): organizations, their roles, Vantage access
 * requests, accounts as Vantage support sees them, and "why can they?" explanations.
 */
import type { Tone } from '@/components/ui/primitives';

export type OrgStatus = 'active' | 'suspended' | 'archived';
export type OrgRoleKey = 'owner' | 'admin' | 'records' | 'auditor';
export type PlatformRoleKey = 'owner' | 'admin' | 'support' | 'auditor';

export interface OrgSummary {
  id: string; name: string; short_name: string | null; status: OrgStatus; root_unit_id: string | null;
  roles: OrgRoleKey[]; permissions: string[]; expiresAt: string | null; member: boolean;
}

export interface OrgCounts { units: number; members: number; owners: number; lastActive: string | null; pendingAccess: number }
export interface PublicOrg {
  id: string; slug: string; name: string; short_name: string | null; status: OrgStatus; root_unit_id: string | null;
  settings: { vantageAccess: 'approval' | 'notify' }; suspended_reason: string | null; suspended_at: string | null; created_at: string; created_by: string | null;
}
export interface PersonRef { id: string; username?: string; first_name: string; last_name: string; rank_abbr: string | null }
export interface OrgListing extends PublicOrg { counts: OrgCounts; owners: PersonRef[] }

export interface OrgRoleHolder {
  user_id: string; username: string; first_name: string; last_name: string; rank_abbr: string | null; role: OrgRoleKey;
  granted_by: string | null; granted_by_name: string | null; expires_at: string | null; created_at: string; member: boolean;
}

export interface AccessGrant {
  id: string; org_id: string; org_name: string; staff_user_id: string; staff_name: string; reason: string; minutes: number;
  status: 'pending' | 'active' | 'denied' | 'revoked' | 'expired' | 'ended' | 'withdrawn';
  requested_at: string; decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  starts_at: string | null; expires_at: string | null; ended_at: string | null;
}

export interface PlatformAccount {
  id: string; username: string; email: string | null; first_name: string; last_name: string; rank_abbr: string | null; active: number;
  totp_enabled: number; must_change_password: number; last_login_at: string | null; locked_until: string | null; created_at: string;
  passkeys: number; organizations: string | null; platform_roles: string | null;
}

export interface OrgMember {
  id: string; username: string; email: string | null; first_name: string; last_name: string; rank_abbr: string | null; edipi: string | null; active: number;
  last_login_at: string | null; totp_enabled: number; must_change_password: number; locked_until: string | null; passkeys: number; other_orgs: number;
  units: Array<{ unit_id: string; unit: string; billet: string | null; is_primary: number; roles: string | null }>;
}

export interface OrgUnit {
  id: string; code: string; name: string; short_name: string | null; echelon: string | null; parent_id: string | null; active: number;
  owner_user_id: string | null; owner_first: string | null; owner_last: string | null; members: number;
}

export interface ExplainedSource { kind: 'role' | 'inherited' | 'owner' | 'org' | 'vantage'; label: string; fromUnitId: string; fromUnitName: string | null; role: string | null; orgRole: string | null; expiresAt: string | null; permissions: string[] }
export interface UnitExplanation { unitId: string; unitName: string; permissions: string[]; readsRecords: boolean; sources: ExplainedSource[] }

export interface RoleCatalogEntry { label: string; description: string; permissions: string[] }
export interface PermissionCatalogEntry { key: string; label: string; hint: string }

export const ACCESS_TONE: Record<AccessGrant['status'], Tone> = { pending: 'warn', active: 'accent', denied: 'neutral', revoked: 'bad', expired: 'neutral', ended: 'neutral', withdrawn: 'neutral' };
export const ACCESS_LABEL: Record<AccessGrant['status'], string> = { pending: 'Waiting', active: 'Open', denied: 'Denied', revoked: 'Ended by the organization', expired: 'Expired', ended: 'Finished', withdrawn: 'Withdrawn' };
export const ORG_STATUS_TONE: Record<OrgStatus, Tone> = { active: 'good', suspended: 'warn', archived: 'neutral' };

export const personName = (p: { rank_abbr?: string | null; first_name: string; last_name: string }) => `${p.rank_abbr ? `${p.rank_abbr} ` : ''}${p.first_name} ${p.last_name}`.trim();

/** "in 3 h 20 min", "in 12 min", or "ended". */
export function remaining(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'ended';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `in ${h} h${m ? ` ${m} min` : ''}`;
}

/** A date input's value as the end of that day, local time, for "until" grants. */
export const endOfDay = (day: string) => (day ? new Date(`${day}T23:59:00`).toISOString() : null);

/** Tomorrow as a date input's value: the earliest end a time-bound grant may have. */
export const tomorrowKey = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
