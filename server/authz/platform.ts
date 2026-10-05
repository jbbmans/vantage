import type { AppContext, SessionUser } from '../context.ts';
import { platformPermissionsOf, PLATFORM_ROLE_KEYS, type PlatformPermission, type PlatformRole } from '../../shared/permissions.ts';

/** The platform roles an account holds: Vantage staff. They run the service and confer nothing inside an organization. */
export function platformRolesOf(ctx: AppContext, userId: string): PlatformRole[] {
  return (ctx.db.prepare('SELECT role FROM platform_roles WHERE user_id = ?').all(userId) as Array<{ role: string }>)
    .map((r) => r.role as PlatformRole)
    .filter((r) => PLATFORM_ROLE_KEYS.includes(r));
}

export const isStaff = (user: Pick<SessionUser, 'platform'>) => user.platform.length > 0;
export const platformCan = (user: Pick<SessionUser, 'platformPermissions'>, permission: PlatformPermission) => user.platformPermissions.includes(permission);

export function withPlatform<T extends { id: string }>(ctx: AppContext, user: T): T & { platform: PlatformRole[]; platformPermissions: PlatformPermission[] } {
  const platform = platformRolesOf(ctx, user.id);
  return { ...user, platform, platformPermissions: platformPermissionsOf(platform) };
}

/** Everyone who holds a platform permission, for the platform's own notices. */
export function staffWith(ctx: AppContext, permission: PlatformPermission): string[] {
  const rows = ctx.db.prepare('SELECT DISTINCT pr.user_id, pr.role FROM platform_roles pr JOIN users u ON u.id = pr.user_id WHERE u.active = 1').all() as Array<{ user_id: string; role: string }>;
  return [...new Set(rows.filter((r) => platformPermissionsOf([r.role]).includes(permission)).map((r) => r.user_id))];
}
