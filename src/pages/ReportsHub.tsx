import { lazy, Suspense } from 'react';
import { PageHeader, Skeleton, Tabs } from '@/components/ui/primitives';
import { useParam } from '@/components/common';

const ReportStudio = lazy(() => import('./ReportStudio'));
const Reports = lazy(() => import('./Reports'));

/**
 * Writing the package and reading what the record says were separate destinations, which put the
 * evidence one navigation away from the paragraph it was supposed to support. They are one screen
 * now: the analysis is the thing you write from.
 */
export default function ReportsHub() {
  const [tab, setTab] = useParam('tab', 'packages');
  return (
    <div className="page">
      <PageHeader
        eyebrow="Reports"
        title="Your work, clearly told."
        lede="Build the package against the facts already in your record, and check what that record actually shows before you claim it."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[{ value: 'packages', label: 'Packages' }, { value: 'analysis', label: 'Analysis' }]}
      />
      <Suspense fallback={<Skeleton className="h-64" />}>
        {tab === 'packages' ? <ReportStudio embedded /> : <Reports embedded />}
      </Suspense>
    </div>
  );
}
