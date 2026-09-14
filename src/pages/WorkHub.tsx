import { lazy, Suspense } from 'react';
import { PageHeader, Skeleton, Tabs } from '@/components/ui/primitives';
import { useParam } from '@/components/common';
import { useTasks, useThreads } from '@/lib/queries';

const Workbench = lazy(() => import('./Workbench'));
const Work = lazy(() => import('./Work'));
const Correspondence = lazy(() => import('./Correspondence'));

/**
 * Everything with a next action lives here. The queue, the tasks you set yourself, the projects
 * they roll up to, and the email the whole thing is actually about were four destinations, which
 * meant four places to check before you knew what today held. They are four tabs now because the
 * question each one answers is the same question: what is waiting on me?
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
        title="Keep the work moving."
        lede="The queue, what you owe, and the correspondence behind it. Finishing something here writes the record of it."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: 'queue', label: 'Case queue' },
          { value: 'tasks', label: 'Tasks', count: openTasks || undefined },
          { value: 'projects', label: 'Projects' },
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
