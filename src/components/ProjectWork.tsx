import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileSpreadsheet, PenLine } from 'lucide-react';
import { Panel, Button, Input, Field, Badge, Skeleton, EmptyState } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { DateText, StatusBadge } from '@/components/common';
import * as api from '@/lib/api';

/**
 * The work under a project — typed and imported, in one list.
 *
 * This is the whole point of the exercise. A project and the case queue used to be unrelated piles
 * with no column joining them, so "the tasks in this project" and "the rows on that spreadsheet"
 * could never be the same thing. They can now, and the only difference the reader sees is a small
 * mark saying where a row came from, because that difference is real: a row off a sheet keeps its
 * values read-only, and a typed one does not.
 */

interface WorkRow {
  id: string;
  title: string;
  reference: string | null;
  due_date: string | null;
  state: string;
  claimed_by: string | null;
  source_file_id: string | null;
  version: number;
}

export function ProjectWork({ projectId, unitId, canAdd }: { projectId: string; unitId: string | null; canAdd: boolean }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['project-work', projectId],
    queryFn: () => api.listWorkItems({ project_id: projectId, unit_id: unitId || undefined, limit: 200 }),
    enabled: Boolean(projectId),
  });
  const items: WorkRow[] = data?.items || [];

  const add = async () => {
    const text = title.trim();
    if (!text) return;
    setBusy(true);
    try {
      await api.createWorkItem({ title: text, project_id: projectId, unit_id: unitId, visibility: unitId ? 'unit' : 'private' });
      setTitle(''); setAdding(false); refetch();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <Panel
      title="Work under this project"
      subtitle={items.length
        ? `${items.length} ${items.length === 1 ? 'case' : 'cases'}, however they got here`
        : 'Type a case in here. Filing imported sheet rows under a project is server-side only for now.'}
      action={canAdd && !adding ? <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add</Button> : undefined}
    >
      {adding && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="What needs doing?" className="min-w-[16rem] flex-1">
            <Input value={title} autoFocus onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } if (e.key === 'Escape') setAdding(false); }} />
          </Field>
          <span className="flex gap-2 pb-0.5">
            <Button size="sm" variant="primary" loading={busy} disabled={!title.trim()} onClick={add}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setTitle(''); }}>Cancel</Button>
          </span>
        </div>
      )}

      {isLoading ? <Skeleton className="h-24" />
        : !items.length ? (
          <EmptyState
            title="Nothing filed under this project yet"
            description="Work typed in here lands in this list. Imported sheet rows can be filed under a project through the API; the control for doing it from the workbench is not built yet."
          />
        ) : (
          <ul className="hairline-grid border border-line">
            {items.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{row.title}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                    {/* Where a row came from decides what may be edited on it, so it is worth showing. */}
                    {row.source_file_id
                      ? <span className="flex items-center gap-1" title="Imported: its figures are what the sheet said"><FileSpreadsheet className="h-3 w-3" />From a sheet</span>
                      : <span className="flex items-center gap-1" title="Typed in here, so its own fields can be corrected"><PenLine className="h-3 w-3" />Typed in</span>}
                    {row.reference && <span className="fig">{row.reference}</span>}
                    {row.due_date && <DateText value={row.due_date} />}
                  </span>
                </span>
                {row.claimed_by && <Badge tone="neutral">Held</Badge>}
                <StatusBadge value={row.state} />
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
