import type { AppContext } from '../context.ts';
import { isTimeZone } from '../../shared/schemas.ts';

/**
 * Whose calendar decides "today". A person may set their own timezone; a reserve unit's Marines live in every US
 * zone, and an instance has one. Without a setting, the instance's timezone is everyone's.
 */
export const zoneOf = (ctx: AppContext, user?: { timezone?: string | null } | null): string =>
  user?.timezone && isTimeZone(user.timezone) ? user.timezone : ctx.config.timezone;
