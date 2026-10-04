import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpenCheck, Briefcase, Gauge, Menu as MenuIcon, Plus, type LucideIcon } from 'lucide-react';
import { groupFor } from '@/config/nav';
import { cn } from '@/lib/utils';

const TYPING = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  return Boolean(node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable));
};

/**
 * The phone's navigation, where a thumb reaches: Today, Work, a log button, the Record, and everything else behind
 * More (the drawer). Below the large breakpoint only; on a desk the rail does this. It steps aside while someone types,
 * since an on-screen keyboard pushes a fixed bar up over the field, and while the drawer is open.
 */
export default function TabBar({ hidden, onLog, onMore }: { hidden: boolean; onLog: () => void; onMore: () => void }) {
  const { pathname } = useLocation();
  const group = groupFor(pathname)?.id;
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const on = (e: FocusEvent) => setTyping(TYPING(e.target));
    // Focus leaves one field for the next in a moment; read where it landed, not where it left.
    const off = () => { window.setTimeout(() => setTyping(TYPING(document.activeElement)), 0); };
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
      <button type="button" className="tabbar-log" onClick={onLog} aria-label="Log what you did">
        <span><Plus aria-hidden /></span>
      </button>
      {link('/record', 'Record', BookOpenCheck, group === 'record')}
      <button type="button" className="tabbar-item" onClick={onMore}><MenuIcon aria-hidden /><span>More</span></button>
    </nav>
  );
}
