import { useLocation } from 'react-router-dom';
import { groupFor, pageFor } from '@/config/nav';

/**
 * Where the current address sits, as the menu names it. A page's eyebrow reads its group from here, so the heading
 * never disagrees with the menu when a page moves between groups (ADR-0016).
 */
export function usePlace(): { group?: string; page?: string } {
  const { pathname } = useLocation();
  return { group: groupFor(pathname)?.label, page: pageFor(pathname)?.label };
}
