import { Funnel, X } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';

/**
 * Narrowing an audit trail or a unit's access log to one person, by their id: a button beside a name in an entry, and a
 * chip that says whose entries are shown, with the way back to everyone. The button is an icon with a name and no text,
 * so the cell still reads as the name alone.
 */
export function ShowOnlyPerson({ name, onPick }: { name: string; onPick: () => void }) {
  const label = `Show only ${name || 'this person'}`;
  return (
    <Button size="icon-xs" variant="ghost" className="ml-1 align-middle text-ink-3" aria-label={label} title={label} onClick={onPick}>
      <Funnel className="h-3 w-3" aria-hidden />
    </Button>
  );
}

/**
 * Whose entries a list shows, and the button that shows everyone's again. Focus moves here when a person is picked. The
 * button takes the chip off the page with it, so `onClear` also moves focus to something of the list that stays.
 */
export function PersonChip({ id, name, onClear }: { id: string; name: string; onClear: () => void }) {
  return (
    <Badge id={id} tabIndex={-1} tone="accent" className="gap-1 py-0 pr-0">
      Only {name || 'one person'}
      <Button size="icon-xs" variant="ghost" aria-label="Show everyone" title="Show everyone" onClick={onClear}><X className="h-3 w-3" aria-hidden /></Button>
    </Badge>
  );
}

/** The name an entry gives the person a list is narrowed to: who did it, or whose it was. */
export function personNamed<R extends { actor_id?: string | null; subject_id?: string | null }>(rows: R[], person: string, actor: (r: R) => string, subject: (r: R) => string) {
  for (const r of rows) {
    if (r.actor_id === person && actor(r)) return actor(r);
    if (r.subject_id === person && subject(r)) return subject(r);
  }
  return '';
}
