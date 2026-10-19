import { History, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useRecordLineage, useUndoMove } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatDate } from '../../shared/metrics';
import { MOVABLE_LABELS, type LineageMove, type MovableTable } from '../../shared/recordKinds';
import type { MovedEntry } from '@/components/MoveRecordDialog';
import { cn } from '@/lib/utils';

const SHOWN = 5;

/**
 * Where an entry came from: each move between record types that led to it, newest first, and Undo for the move that
 * brought it here (ADR-0015). Nothing shows for an entry that never moved. Why it moved is its owner's alone.
 */
export default function RecordLineage({ store, id, onUndone, className }: { store: MovableTable; id: string; onUndone?: (restored: MovedEntry) => void; className?: string }) {
  const toast = useToast();
  const { data } = useRecordLineage(store, id);
  const undo = useUndoMove(store);
  if (!data?.moves.length) return null;

  const line = (m: LineageMove) => {
    const here = m.to_table === store && m.to_id === id;
    const from = MOVABLE_LABELS[m.from_table].place; const to = MOVABLE_LABELS[m.to_table].place;
    if (m.method === 'undo') return here ? `Moved back here from ${from}` : `Moved back from ${from} to ${to}`;
    return here ? `Moved here from ${from}` : `Moved from ${from} to ${to}`;
  };
  const undoMove = async () => {
    try {
      const back = await undo.mutateAsync(id);
      toast.success(`Move undone. It is back in ${MOVABLE_LABELS[back.table].place}.`);
      onUndone?.({ table: back.table, id: back.id });
    } catch (e) { toast.error(api.errorText(e)); }
  };
  const older = data.moves.length - SHOWN;

  return (
    <section aria-label="Where this entry came from" className={cn('flex flex-wrap items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2', className)}>
      <History className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <ul className="min-w-0 flex-1 space-y-1">
        {data.moves.slice(0, SHOWN).map((m) => (
          <li key={m.id}>{line(m)} on <span className="fig">{formatDate(m.at, 'd MMM yyyy')}</span>.{m.reason ? <span className="text-ink-3"> “{m.reason}”</span> : null}</li>
        ))}
        {older > 0 && <li className="text-xs text-ink-3">{older} earlier {older === 1 ? 'move' : 'moves'}.</li>}
      </ul>
      {data.undo && <Button size="sm" onClick={undoMove} loading={undo.isPending} title={`Puts it back in ${MOVABLE_LABELS[data.undo.from_table].place}, as it was`}><Undo2 className="h-3.5 w-3.5" />Undo move</Button>}
    </section>
  );
}
