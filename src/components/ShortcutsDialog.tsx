import { Dialog } from '@/components/ui/Dialog';
import { Kbd, Switch } from '@/components/ui/primitives';
import { usePrefs, useSavePrefs } from '@/lib/queries';
import { shortcutsOn } from '@/lib/keyboard';
import type { NavGroup, NavPage } from '@/config/nav';

/**
 * The keys, and a "G then" line for each page and group this person may open: the same list as the menu and ⌘K. The
 * switch above them turns every single-key shortcut off or on, as Settings → Appearance does (WCAG 2.1.4).
 */
export default function ShortcutsDialog({ open, onOpenChange, nav, groups, views }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavPage[]; groups: NavGroup[]; views: boolean }) {
  const on = shortcutsOn(usePrefs());
  const save = useSavePrefs();
  // In the order the shell reads them (AppShell's goKeys): a page's own key first, then each group's.
  const keyed = [...nav.filter((n) => n.key).map((n) => ({ label: n.label, key: n.key! })), ...groups.map((g) => ({ label: g.label, key: g.key }))];
  // A key is listed once, for where it goes.
  const seen = new Set<string>();
  const go = keyed.filter((k) => !seen.has(k.key) && (seen.add(k.key), true)).map((k) => [`Go to ${k.label}`, ['G', k.key.toUpperCase()]] as [string, string[]]);
  const rows: Array<[string, string[]]> = [
    ['Log activity', ['N']], ['Search and jump', ['/', '⌘K']], ...(views ? [['Switch view', ['V']] as [string, string[]]] : []), ['Collapse the menu', ['[']], ['This list', ['?']],
    ['Work queue rows: move down, up', ['J', 'K']], ['Work queue rows: select, open, claim', ['Space', 'Enter', 'C']],
    ...go,
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="sm">
      <div className="mb-2 border-b border-line pb-2">
        <Switch checked={on} onChange={(v) => save.mutate({ shortcuts: v })} label="Keyboard shortcuts"
          description="Single keys work anywhere but a text field; the queue's keys only in its rows. Off, only ⌘K or Ctrl+K is left, for search. Also in Settings → Appearance." />
      </div>
      <ul className="divide-y divide-line">
        {rows.map(([label, keys]) => <li key={label} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="text-ink-2">{label}</span><span className="flex shrink-0 gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span></li>)}
      </ul>
    </Dialog>
  );
}
