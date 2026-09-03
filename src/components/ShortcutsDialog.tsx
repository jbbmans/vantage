import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/primitives';
import { NAV } from '@/config/nav';

export default function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const rows: Array<[string, string[]]> = [['Log activity', ['N']], ['Search and jump', ['/', '⌘K']], ['This list', ['?']], ...NAV.map((n) => [`Go to ${n.label}`, ['G', n.key.toUpperCase()]] as [string, string[]])];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="sm">
      <ul className="divide-y divide-line">
        {rows.map(([label, keys]) => <li key={label} className="flex items-center justify-between py-2 text-sm"><span className="text-ink-2">{label}</span><span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span></li>)}
      </ul>
    </Dialog>
  );
}
