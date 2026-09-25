import { useSyncExternalStore } from 'react';
import type { Identity, UnitView } from './queries';

const listeners = new Set<() => void>();
const key = (userId: string) => `vantage.view.${userId}`;
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const read = (userId: string | undefined) => { if (!userId) return null; try { return localStorage.getItem(key(userId)); } catch { return null; } };

export function chooseView(userId: string, viewId: string) {
  try { localStorage.setItem(key(userId), viewId); } catch { /* ignore */ }
  for (const fn of listeners) fn();
}

/** The unit everyone's pages are looking at: a whole command or one team. */
export function useView(identity: Identity | undefined) {
  const stored = useSyncExternalStore(subscribe, () => read(identity?.user.id), () => null);
  const views = identity?.views || [];
  const view = views.find((v) => v.id === stored) || views.find((v) => v.id === identity?.defaultViewId) || views[0] || null;
  return { view, views, setView: (id: string) => { if (identity) chooseView(identity.user.id, id); } };
}

/** The view and every view beneath it, for roll-ups the client does itself. */
export function subtreeOf(views: UnitView[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i += 1) for (const v of views) if (v.parent_id === out[i] && !out.includes(v.id)) out.push(v.id);
  return out;
}

export const viewLabel = (v: UnitView | null | undefined) => (v ? v.short_name || v.name : '');

/** How a person is described under their name: their highest role where they are looking, else where they belong. */
export function roleLine(identity: Identity | undefined, view: UnitView | null) {
  if (!identity) return '';
  const pick = (unitId: string | null | undefined) => (unitId ? identity.roles.filter((r) => r.unit_id === unitId).sort((a, b) => b.position - a.position)[0] : undefined);
  const role = pick(view?.id) || pick(identity.primaryUnitId) || [...identity.roles].sort((a, b) => b.position - a.position)[0];
  const billet = identity.memberships.find((m) => m.unit_id === (view?.id || identity.primaryUnitId))?.billet;
  if (role && role.position > 0) return role.name;
  if (billet) return billet;
  if (identity.user.is_operator) return 'Instance owner';
  return role?.name || 'Marine';
}
