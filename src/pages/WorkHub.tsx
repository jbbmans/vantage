import { lazy, Suspense } from 'react';
import { PageHeader, Skeleton, Tabs } from '@/components/ui/primitives';
import { useParam } from '@/components/common';
import { useTasks, useThreads } from '@/lib/queries';

const Workbench = lazy(() => import('./Workbench'));
const Work = lazy(() => import('./Work'));
const Correspondence = lazy(() => import('./Correspondence'));

/**
 * Everything with a next action lives here. The queue of project items, the projects
 * they roll up to, the tasks you set yourself, and the email the work is actually about were four
 * destinations. They are four tabs because each answers the same question: what work exists, what
 * is mine, and where does it stand? One item opens on its own page, at /work/items/:id.
 */
export default function WorkHub() {
  const [tab, setTab] = useParam('tab', 'queue');
  const { data: tasks } = useTasks();
  const threads = useThreads({ state: 'awaiting_reply' });

  const openTasks = (tasks || []).filter((t: any) => t.status !== 'completed').length;
  const waiting = threads.data?.length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Work"
        title="Work"
        lede="Every project item, what is yours, what is open to claim, and the correspondence behind it. What you do here is recorded for you."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: 'queue', label: 'Queue' },
          { value: 'projects', label: 'Projects' },
          { value: 'tasks', label: 'Tasks', count: openTasks || undefined },
          { value: 'mail', label: 'Correspondence', count: waiting || undefined },
        ]}
      />
      <Suspense fallback={<Skeleton className="h-64" />}>
        {tab === 'queue' && <Workbench embedded />}
        {(tab === 'tasks' || tab === 'projects') && <Work embedded />}
        {tab === 'mail' && <Correspondence embedded />}
      </Suspense>
    </div>
  );
}
