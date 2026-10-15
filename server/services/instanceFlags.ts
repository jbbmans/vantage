import type { AppContext, SessionUser } from '../context.ts';
import { now } from '../lib/ids.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { orgOfUnit } from '../authz/scope.ts';
import { audit } from './audit.ts';
import { notifyOrg } from './notifications.ts';
import { primaryOrgOf } from './org.ts';

/**
 * Features a Vantage Administrator can turn off for one Unit Instance (ADR-0014). The service's own switch still decides
 * whether a feature runs at all; this only withholds it from one Unit Instance, with a reason its Lead Unit Managers are
 * told. Nothing here turns a feature on for one Unit Instance that the service has off, so no Unit Instance can be given
 * more than the enterprise allows. AI assistance stays service-wide: what one person sends to it can span Unit Instances.
 */

export const INSTANCE_FLAGS = [
  { key: 'attachments', label: 'File attachments', hint: 'Attaching files to records. Files already attached stay readable.' },
  { key: 'intake', label: 'Spreadsheet intake', hint: 'Uploading spreadsheets to import as work. Imports already run stay.' },
] as const;

export type InstanceFlag = (typeof INSTANCE_FLAGS)[number]['key'];
export const INSTANCE_FLAG_KEYS = INSTANCE_FLAGS.map((f) => f.key) as InstanceFlag[];
export const isInstanceFlag = (value: unknown): value is InstanceFlag => (INSTANCE_FLAG_KEYS as unknown[]).includes(value);
const labelOf = (flag: InstanceFlag) => INSTANCE_FLAGS.find((f) => f.key === flag)!.label;

export interface WithheldFlag { org_id: string; org_name: string; flag: InstanceFlag; label: string; reason: string; set_at: string; set_by: string | null; set_by_name: string | null }

/** Whether the service runs the feature at all, before any Unit Instance's flag. */
export function serviceOn(ctx: AppContext, flag: InstanceFlag): boolean {
  return flag === 'attachments' ? Boolean(ctx.runtime.attachmentsEnabled) : Boolean(ctx.config.intake.enabled);
}

/** Every withheld feature, by Unit Instance, or one Unit Instance's. */
export function withheldFlags(ctx: AppContext, orgId?: string): WithheldFlag[] {
  const rows = ctx.db.prepare(`SELECT f.org_id, o.name AS org_name, f.flag, f.reason, f.set_at, f.set_by, trim(u.first_name || ' ' || u.last_name) AS set_by_name
      FROM instance_feature_flags f JOIN organizations o ON o.id = f.org_id LEFT JOIN users u ON u.id = f.set_by
      WHERE (? IS NULL OR f.org_id = ?) ORDER BY o.name, f.flag`).all(orgId ?? null, orgId ?? null) as Array<Omit<WithheldFlag, 'label'>>;
  return rows.filter((r) => isInstanceFlag(r.flag)).map((r) => ({ ...r, label: labelOf(r.flag) }));
}

export function isWithheld(ctx: AppContext, orgId: string | null | undefined, flag: InstanceFlag): boolean {
  if (!orgId) return false;
  return Boolean(ctx.db.prepare('SELECT 1 FROM instance_feature_flags WHERE org_id = ? AND flag = ?').get(orgId, flag));
}

/**
 * The Unit Instance whose flag governs something placed in this unit: the unit's own, or for something in no unit (a
 * private record or upload), the Unit Instance of its owner's primary unit.
 */
export function governingInstance(ctx: AppContext, unitId: string | null | undefined, ownerId: string | null | undefined): string | null {
  return orgOfUnit(ctx, unitId) ?? (ownerId ? primaryOrgOf(ctx, ownerId)?.orgId ?? null : null);
}

/** Whether the feature runs for something in this unit, owned by this person. */
export function featureOn(ctx: AppContext, flag: InstanceFlag, unitId: string | null | undefined, ownerId: string | null | undefined): boolean {
  return serviceOn(ctx, flag) && !isWithheld(ctx, governingInstance(ctx, unitId, ownerId), flag);
}

/** For the Feature flags page: each flag a Unit Instance can be denied, whether the service runs it, and where it is withheld. */
export function instanceFlagStatus(ctx: AppContext) {
  return { flags: INSTANCE_FLAGS.map((f) => ({ ...f, serviceOn: serviceOn(ctx, f.key) })), withheld: withheldFlags(ctx) };
}

/**
 * Turns a feature off for one Unit Instance, with a reason, or gives it back the service's setting. Audited in the platform
 * trail and the Unit Instance's, and its Lead Unit Managers are told.
 */
export function setInstanceFlag(ctx: AppContext, actor: SessionUser, orgId: string, flag: InstanceFlag, { withheld, reason }: { withheld: boolean; reason: string | null }, ip?: string) {
  const org = ctx.db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId) as { id: string; name: string } | undefined;
  if (!org) throw notFound('No such Unit Instance.');
  const text = (reason ?? '').trim();
  const current = withheldFlags(ctx, orgId).find((f) => f.flag === flag);
  const label = labelOf(flag);
  if (withheld) {
    if (text.length < 10) throw badRequest('Say why, in at least ten characters. The Unit Instance’s Lead Unit Managers are told.', { code: 'reason_required' });
    ctx.db.transaction(() => {
      ctx.db.prepare(`INSERT INTO instance_feature_flags (org_id, flag, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(org_id, flag) DO UPDATE SET reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`).run(orgId, flag, text.slice(0, 500), actor.id, now());
      audit(ctx, { actor_id: actor.id, action: 'instance_feature_withheld', category: 'enterprise', entity: 'organization', entity_id: orgId, org_id: orgId, detail: `${label} off for ${org.name}${current ? ' (reason changed)' : ''}: ${text.slice(0, 500)}`, ip });
    })();
    notifyOrg(ctx, orgId, 'org.owners', { kind: 'system', title: `Vantage turned ${label.toLowerCase()} off for ${org.name}`, message: text.slice(0, 300), actionUrl: '/console/operations' });
  } else {
    if (!current) return withheldFlags(ctx, orgId);
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM instance_feature_flags WHERE org_id = ? AND flag = ?').run(orgId, flag);
      audit(ctx, { actor_id: actor.id, action: 'instance_feature_restored', category: 'enterprise', entity: 'organization', entity_id: orgId, org_id: orgId, detail: `${label} follows the service again for ${org.name}${text ? `: ${text.slice(0, 500)}` : ''}; it was off since ${current.set_at.slice(0, 10)}: ${current.reason}`.slice(0, 1000), ip });
    })();
    notifyOrg(ctx, orgId, 'org.owners', { kind: 'system', title: `${label} is back for ${org.name}`, message: serviceOn(ctx, flag) ? 'Vantage gave your Unit Instance the service’s setting again.' : 'Vantage gave your Unit Instance the service’s setting again; the service has it off for everyone at the moment.', actionUrl: '/console/operations' });
  }
  return withheldFlags(ctx, orgId);
}
