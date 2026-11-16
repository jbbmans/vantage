import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpenCheck, Briefcase, Gauge, Menu as MenuIcon, Plus, Users, type LucideIcon } from 'lucide-react';
import { groupFor } from '@/config/nav';
import { cn } from '@/lib/utils';
import { isTextEntry } from '@/lib/keyboard';

/**
 * The phone's navigation, where a thumb reaches: Today, Work, a log button, Records (Personnel, for a leader), and everything else behind
 * More (the drawer). Below the large breakpoint only; on a desk the rail does this. It steps aside while someone types,
 * since an on-screen keyboard pushes a fixed bar up over the field, and while the drawer is open.
 */
export default function TabBar({ hidden, leads, onLog, onMore }: { hidden: boolean; leads: boolean; onLog: () => void; onMore: () => void }) {
  const { pathname } = useLocation();
  const group = groupFor(pathname)?.id;
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    // Only a field that takes text brings up the on-screen keyboard. A checkbox or a radio button does not, and the bar
    // stepping aside for one moved the page under it, then came back over whatever took focus next.
    const on = (e: FocusEvent) => setTyping(isTextEntry(e.target));
    // Focus leaves one field for the next in a moment; read where it landed, not where it left.
    const off = () => { window.setTimeout(() => setTyping(isTextEntry(document.activeElement)), 0); };
    window.addEventListener('focusin', on);
    window.addEventListener('focusout', off);
    return () => { window.removeEventListener('focusin', on); window.removeEventListener('focusout', off); };
  }, []);

  // Toasts and the like sit above the bar while it is there (see --tabbar in index.css).
  const shown = !hidden && !typing;
  useEffect(() => {
    document.documentElement.classList.toggle('has-tabbar', shown);
    return () => document.documentElement.classList.remove('has-tabbar');
  }, [shown]);
  if (!shown) return null;

  const link = (to: string, label: string, Icon: LucideIcon, active: boolean) => (
    // A plain link with its own idea of "here": Work is current on any Work page, not only the one it opens.
    <Link to={to} className={cn('tabbar-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
      <Icon aria-hidden /><span>{label}</span>
    </Link>
  );

  return (
    <nav className="tabbar no-print lg:hidden" aria-label="Quick navigation">
      {link('/', 'Today', Gauge, pathname === '/')}
      {link('/work/queue', 'Work', Briefcase, group === 'work')}
      <button type="button" className="tabbar-log" onClick={onLog} aria-label="Log activity">
        <span><Plus aria-hidden /></span>
      </button>
      {/* Somebody who leads a team checks it more than their own record; theirs is a tap away under More. */}
      {leads ? link('/team/workload', 'Personnel', Users, group === 'personnel') : link('/record', 'Records', BookOpenCheck, group === 'records')}
      {/* The bar steps aside while the drawer is open, so the drawer finds this button again by its mark to give focus back. */}
      <button type="button" className="tabbar-item" onClick={onMore} aria-haspopup="dialog" data-drawer-opener="more"><MenuIcon aria-hidden /><span>More</span></button>
    </nav>
  );
}
