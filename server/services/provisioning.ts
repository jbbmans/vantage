import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { slug } from '../lib/ids.ts';
import { platformRolesOf } from '../authz/platform.ts';
import { platformPermissionsOf } from '../../shared/permissions.ts';
import { audit } from './audit.ts';
import { assertCanFoundUnitInstance } from './deployment.ts';
import { createOrganization, getOrg, nameFirstOwner, orgRoleHolders } from './organizations.ts';

/**
 * Provisioning a Unit Instance from a manifest (ADR-0007): what a Vantage Administrator does in the admin dashboard, made
 * repeatable for whatever MCEN's provisioning process turns out to be. It reuses the same service calls, so a Unit
 * Instance made here is the same as one made there, audited to the administrator who ran it. Running a manifest again
 * changes nothing that is already true.
 */
export const unitInstanceManifest = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).optional(),
  short_name: z.string().trim().max(40).optional(),
  /** The first Unit Manager (an owner of the Unit Instance): an existing active account, by username or DoD ID. */
  manager: z.string().trim().min(1).max(80).optional(),
}).strict();
export type UnitInstanceManifest = z.infer<typeof unitInstanceManifest>;

export interface ProvisionResult {
  unitInstance: { id: string; name: string; status: string };
  action: 'created' | 'would_create' | 'exists';
  manager: 'named' | 'would_name' | 'already_manager' | 'has_managers' | 'none';
  dryRun: boolean;
}

/** The administrator a script acts as, who must hold platform.orgs: the same permission the admin dashboard asks for. */
export function provisioningActor(ctx: AppContext, username: string) {
  const user = ctx.db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(username.trim()) as { id: string; username: string } | undefined;
  if (!user) throw new Error(`No active account named ${username}.`);
  if (!platformPermissionsOf(platformRolesOf(ctx, user.id)).includes('platform.orgs')) throw new Error(`${user.username} is not a Vantage Administrator who may provision Unit Instances (platform.orgs).`);
  return user;
}

function findManager(ctx: AppContext, who: string) {
  const user = /^\d{10}$/.test(who)
    ? ctx.db.prepare('SELECT id, username FROM users WHERE edipi = ? AND active = 1').get(who)
    : ctx.db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(who);
  if (!user) throw new Error(`No active account matches the manager "${who}" (a username, or a 10-digit DoD ID). Nothing was changed.`);
  return user as { id: string; username: string };
}

export function provisionUnitInstance(ctx: AppContext, actor: { id: string }, input: unknown, opts: { dryRun?: boolean } = {}): ProvisionResult {
  const manifest = unitInstanceManifest.parse(input);
  const dryRun = Boolean(opts.dryRun);
  const code = slug(String(manifest.code || manifest.short_name || manifest.name));
  if (!code) throw new Error('The manifest name produces an empty code. Give the Unit Instance a code.');
  // Everything that could refuse is checked before anything is written, so a failed run leaves nothing half made.
  const manager = manifest.manager ? findManager(ctx, manifest.manager) : null;
  const existing = getOrg(ctx, code);

  if (!existing) {
    assertCanFoundUnitInstance(ctx);
    if (dryRun) return { unitInstance: { id: code, name: manifest.name, status: 'active' }, action: 'would_create', manager: manager ? 'would_name' : 'none', dryRun };
    const made = createOrganization(ctx, actor, { name: manifest.name, short_name: manifest.short_name ?? null, code, owner_user_id: manager?.id ?? null });
    audit(ctx, { actor_id: actor.id, action: 'unit_instance_provisioned', entity: 'organization', entity_id: code, org_id: code, subject_id: manager?.id ?? null, detail: 'from a manifest' });
    return { unitInstance: { id: made.id, name: made.name, status: made.status }, action: 'created', manager: manager ? 'named' : 'none', dryRun };
  }

  if (existing.name !== manifest.name) throw new Error(`Unit Instance ${code} exists as "${existing.name}", not "${manifest.name}". Rename it in the admin dashboard, or use another code.`);
  const summary = { id: existing.id, name: existing.name, status: existing.status };
  if (!manager) return { unitInstance: summary, action: 'exists', manager: 'none', dryRun };
  const owners = orgRoleHolders(ctx, code).filter((r) => r.role === 'owner');
  if (owners.some((o) => o.user_id === manager.id)) return { unitInstance: summary, action: 'exists', manager: 'already_manager', dryRun };
  // Managers name any further managers themselves; the platform names one only for a Unit Instance that has none.
  if (owners.length) return { unitInstance: summary, action: 'exists', manager: 'has_managers', dryRun };
  if (dryRun) return { unitInstance: summary, action: 'exists', manager: 'would_name', dryRun };
  nameFirstOwner(ctx, actor, code, manager.id);
  return { unitInstance: summary, action: 'exists', manager: 'named', dryRun };
}
