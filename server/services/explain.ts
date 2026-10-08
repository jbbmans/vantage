import type { AppContext } from '../context.ts';
import { scopeFor, type Source } from '../authz/scope.ts';
import { listPermissions, ORG_ROLES, PERMISSIONS, type PermissionKey } from '../../shared/permissions.ts';

/**
 * "Why can they?" (ADR-0006): for each unit a person holds authority in, every grant that gives it to them and what
 * each grant carries. A leader checking an SNCOIC's reach, or an owner reviewing who can read what, sees the role and
 * where it was granted, inheritance down the chain, unit leadership, organization administration and Vantage access,
 * each with its end date when it has one.
 */
export interface ExplainedSource {
  kind: Source['kind'];
  label: string;
  fromUnitId: string;
  fromUnitName: string | null;
  role: string | null;
  orgRole: string | null;
  expiresAt: string | null;
  permissions: PermissionKey[];
}
export interface UnitExplanation { unitId: string; unitName: string; permissions: PermissionKey[]; readsRecords: boolean; sources: ExplainedSource[] }

const keysOf = (bits: number): PermissionKey[] => (bits & PERMISSIONS.ADMINISTRATOR ? ['ADMINISTRATOR'] : listPermissions(bits));

export function explainAccess(ctx: AppContext, targetId: string, unitIds?: string[]): UnitExplanation[] {
  const scope = scopeFor(ctx, { id: targetId });
  const wanted = unitIds ? new Set(unitIds) : null;
  const ids = Object.keys(scope.sources).filter((id) => !wanted || wanted.has(id));
  if (!ids.length) return [];
  const names = new Map((ctx.db.prepare('SELECT id, COALESCE(short_name, name) AS name FROM units WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...new Set([...ids, ...ids.flatMap((id) => scope.sources[id].map((s) => s.unitId))])])) as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
  const label = (s: Source, unit: string | null) => {
    const from = names.get(s.unitId) ?? s.unitId;
    switch (s.kind) {
      case 'role': return `${s.role?.name ?? 'A role'}, granted in ${unit}`;
      case 'inherited': return `Authority held in ${from}, which reaches the units beneath it`;
      case 'owner': return `Leads ${unit}`;
      case 'org': return `${ORG_ROLES[s.orgRole ?? 'admin'].label}: the unit's structure, never its records`;
      case 'vantage': return 'Vantage support access, approved by the Unit Instance: read-only';
    }
  };
  return ids
    .map((id) => {
      const unitName = names.get(id) ?? id;
      const bits = scope.permissions[id] || 0;
      const permissions = keysOf(bits);
      return {
        unitId: id,
        unitName,
        permissions,
        readsRecords: Boolean(bits & (PERMISSIONS.ADMINISTRATOR | PERMISSIONS.VIEW_RECORDS)),
        sources: scope.sources[id].map((s) => ({
          kind: s.kind,
          label: label(s, unitName),
          fromUnitId: s.unitId,
          fromUnitName: names.get(s.unitId) ?? null,
          role: s.role?.name ?? null,
          orgRole: s.orgRole ?? null,
          expiresAt: s.expiresAt ?? null,
          permissions: keysOf(s.bits),
        })),
      };
    })
    .sort((a, b) => a.unitName.localeCompare(b.unitName));
}
