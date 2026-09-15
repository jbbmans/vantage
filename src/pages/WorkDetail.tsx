import { useEffect } from 'react';
import { useNavigate, useParams, Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Lock, Users } from 'lucide-react';
import { Button, Badge, Panel, EmptyState, Skeleton } from '@/components/ui/primitives';
import { DescriptionList, DateText, StatusBadge } from '@/components/common';
import { Comments } from '@/components/Comments';
import { Attachments } from '@/components/Attachments';
import { keys, useIdentity, unitName, useOrg } from '@/lib/queries';
import * as api from '@/lib/api';

/**
 * One task, project or goal, opened on its own.
 *
 * Until now these existed only as rows in a list, which is why there was nowhere to hang a file or
 * hold a conversation: the product had no surface for "this piece of work" as a thing. Everything
 * here is the same record the list shows, plus the two panels that needed a home.
 */

const KINDS = {
  tasks: { label: 'Task', back: '/work?tab=tasks', title: (r: Record<string, string>) => r.title },
  projects: { label: 'Project', back: '/work?tab=projects', title: (r: Record<string, string>) => r.name },
  goals: { label: 'Goal', back: '/goals', title: (r: Record<string, string>) => r.title },
} as const;

type Kind = keyof typeof KINDS;
const isKind = (t: string): t is Kind => Object.prototype.hasOwnProperty.call(KINDS, t);

export default function WorkDetail() {
  const { table = '', id = '' } = useParams();
  const navigate = useNavigate();
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const valid = isKind(table);

  const { data: row, isPending, error } = useQuery({
    queryKey: keys.record(table as api.Store, id),
    queryFn: () => api.getRecord(table as api.Store, id),
    enabled: valid && Boolean(id),
    retry: false,
  });

  const kind = valid ? KINDS[table] : null;
  const heading = row && kind ? kind.title(row) : '';
  useEffect(() => { if (heading) document.title = `${heading} · Vantage`; }, [heading]);

  // An activity has its own far richer page; this route just forwards to it so one link shape works
  // for every kind of record, including the one a mention notification points at.
  if (table === 'activities') return <Navigate to={`/records/${id}`} replace />;

  if (!valid) {
    return (
      <div className="page"><div className="card">
        <EmptyState title="Nothing to open here" description="That is not a kind of work this page can show."
          action={<Button onClick={() => navigate('/work')}>Back to work</Button>} />
      </div></div>
    );
  }
  if (isPending) return <div className="page space-y-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-40" /><Skeleton className="h-48" /></div>;
  if (error || !row) {
    return (
      <div className="page"><div className="card">
        <EmptyState
          title={`That ${kind!.label.toLowerCase()} is not available`}
          description={api.errorText(error) || 'It may have been deleted, or it belongs to somebody whose work you cannot see.'}
          action={<Button onClick={() => navigate(kind!.back)}>Back</Button>}
        />
      </div></div>
    );
  }

  // Editing rights decide whether files may be added, and whether a remark may be moderated away.
  // The server decides both again on every call; this only chooses what is worth offering.
  const bits = row.unit_id ? (identity?.permissions?.[row.unit_id] || 0) : 0;
  const ADMINISTRATOR = 1 << 12, MANAGE_RECORDS = 1 << 3;
  const steward = Boolean(bits & (ADMINISTRATOR | MANAGE_RECORDS));
  const mine = row.user_id === identity?.user.id;
  const canEdit = mine ? !row.frozen_at : steward;

  return (
    <div className="page space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(kind!.back)}><ArrowLeft className="h-4 w-4" />Back</Button>
        <Badge>{kind!.label}</Badge>
        {row.visibility === 'private'
          ? <Badge tone="neutral"><Lock className="h-3 w-3" />Private</Badge>
          : <Badge tone="neutral"><Users className="h-3 w-3" />{unitName(org, row.unit_id) || 'Unit'}</Badge>}
        {row.deleted_at && <Badge tone="bad">In the recycle bin</Badge>}
      </div>

      <div>
        <h1 className="text-xl font-semibold text-ink">{heading}</h1>
        {row.description && <p className="mt-1 max-w-prose text-sm text-ink-2">{row.description}</p>}
        {row.notes && <p className="mt-1 max-w-prose whitespace-pre-wrap text-sm text-ink-2">{row.notes}</p>}
      </div>

      <Panel title="Detail">
        <DescriptionList
          items={[
            ['Status', <StatusBadge key="s" value={row.status} />],
            ['Priority', row.priority || null],
            ['Due', row.due_date ? <DateText key="d" value={row.due_date} /> : null],
            ['Target', row.target_date ? <DateText key="t" value={row.target_date} /> : null],
            ['Started', row.start_date ? <DateText key="b" value={row.start_date} /> : null],
            ['Project', row.project_id ? <Link key="p" className="link" to={`/records/projects/${row.project_id}`}>Open the project</Link> : null],
            ['Created', <DateText key="c" value={row.created_at} />],
          ] as Array<[string, React.ReactNode]>}
        />
      </Panel>

      <Attachments table={table as api.Store} id={id} canEdit={canEdit} />
      <Comments table={table as api.Store} id={id} canModerate={steward} />
    </div>
  );
}
