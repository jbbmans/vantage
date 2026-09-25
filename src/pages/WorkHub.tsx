import { lazy, Suspense } from 'react';
import { PageHeader, Skeleton, Tabs } from '@/components/ui/primitives';
import { useParam } from '@/components/common';
import { useTasks, useThreads } from '@/lib/queries';

const Workbench = lazy(() => import('./Workbench'));
const Work = lazy(() => import('./Work'));
const Correspondence = lazy(() => import('./Correspondence'));

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
        lede="Every tasker item, what is yours, what is open to claim, and the correspondence behind it. What you do here is recorded for you."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: 'queue', label: 'Queue' },
          { value: 'projects', label: 'Taskers and projects' },
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
