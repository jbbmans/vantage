import React from 'react';
import { useSearchParams } from 'react-router-dom';
import Development from '@/pages/Development';
import Recognition from '@/pages/Recognition';
import { Segmented } from '@/components/ui/primitives';

/**
 * Training and recognition are two views of the same thing — what your career
 * file says about you — and they were two nav items doing one job. Merged, and
 * the tab survives a refresh because it lives in the URL.
 */
export default function Career() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'recognition' ? 'recognition' : 'development';

  return (
    <div className="space-y-3">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between">
        <Segmented
          value={tab}
          onChange={(v) => setParams({ tab: v }, { replace: true })}
          options={[
            { value: 'development', label: 'Training & PME' },
            { value: 'recognition', label: 'Recognition' },
          ]}
          label="Career section"
        />
      </div>
      {tab === 'development' ? <Development /> : <Recognition />}
    </div>
  );
}
