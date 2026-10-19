import { useCallback, useMemo } from 'react';
import { FOOTER, GROUPS, HOME, type NavGroup, type NavPage, type Requirement } from '@/config/nav';
import { teamSections, type TeamSection } from '@/lib/teamAccess';
import { useIdentity } from '@/lib/queries';
import { useView } from '@/lib/view';

/**
 * The menu as this person may use it: the groups and pages they may open, for the rail, the drawer, ⌘K, the shortcuts
 * and Help's map of where things are. Every one of them reads it here, so none offers a page another hides.
 */
export function useNav(): { groups: NavGroup[]; footer: NavPage[]; visibleNav: NavPage[]; allowed: (when?: Requirement) => boolean; teams: Set<TeamSection> } {
  const { data: identity } = useIdentity();
  const { view } = useView(identity);
  const teams = useMemo(() => teamSections(identity, view), [identity, view]);
  const allowed = useCallback((when?: Requirement) => {
    if (!when) return true;
    if (when.notDemo && identity?.demo) return false;
    if (when.demo && !identity?.demo) return false;
    if (when.unit && !identity?.views?.length) return false;
    if (when.orgRole && !identity?.orgs?.some((o) => o.status === 'active' && o.permissions.includes('org.view'))) return false;
    if (when.staff && !identity?.platform?.roles.length) return false;
    if (when.maradmins && !identity?.instance.maradminsEnabled) return false;
    if (when.team && !teams.has(when.team)) return false;
    return true;
  }, [identity, teams]);
  const groups = useMemo(() => GROUPS.filter((g) => allowed(g.when)).map((g) => ({ ...g, pages: g.pages.filter((p) => allowed(p.when)) })).filter((g) => g.pages.length), [allowed]);
  const footer = useMemo(() => FOOTER.filter((p) => allowed(p.when)), [allowed]);
  /** Every page offered, titled with its group where the label alone is ambiguous ("Overview"). */
  const visibleNav = useMemo(() => [
    HOME,
    ...groups.flatMap((g) => g.pages.map((p) => ({ ...p, label: g.pages.length > 1 && !p.key ? `${g.label}: ${p.label}` : p.label }))),
    ...footer,
  ], [groups, footer]);
  return { groups, footer, visibleNav, allowed, teams };
}
