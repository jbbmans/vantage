import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Award, BookOpen, Flag, Sparkles } from 'lucide-react';
import Development from '@/pages/Development';
import Recognition from '@/pages/Recognition';
import { useGoals, useRecognitions, useTrainings } from '@/store/useStore';
import { formatDTG, formatNumber } from '@/lib/metrics';
import { Badge, EmptyState, Panel } from '@/components/ui/primitives';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Sparkles },
  { id: 'development', label: 'Training & PME', icon: BookOpen },
  { id: 'recognition', label: 'Recognition', icon: Award },
];

export default function Career() {
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  const tab = TABS.some((item) => item.id === requestedTab) ? requestedTab : 'overview';
  const trainings = useTrainings();
  const recognitions = useRecognitions();
  const goals = useGoals();
  const trainingHours = trainings.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);
  const completedTraining = trainings.filter((item) => item.status === 'completed').length;
  const activeGoals = goals.filter((goal) => goal.status === 'active').length;

  const timeline = useMemo(() => [
    ...trainings.map((item) => ({
      id: `training-${item.id}`,
      date: item.date,
      title: item.title,
      detail: [item.provider, String(item.status || '').replace('_', ' ')].filter(Boolean).join(' · '),
      type: 'Training',
      icon: BookOpen,
    })),
    ...recognitions.map((item) => ({
      id: `recognition-${item.id}`,
      date: item.date,
      title: item.title,
      detail: [item.from_whom, item.organization].filter(Boolean).join(' · '),
      type: 'Recognition',
      icon: Award,
    })),
    ...goals.map((item) => ({
      id: `goal-${item.id}`,
      date: item.due_date || item.start_date || item.created_at,
      title: item.title,
      detail: String(item.status || '').replace('_', ' '),
      type: 'Goal',
      icon: Flag,
    })),
  ].filter((item) => item.title).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 10), [goals, recognitions, trainings]);

  const selectTab = (id) => {
    setParams(id === 'overview' ? {} : { tab: id }, { replace: true });
  };

  return (
    <div className="page-canvas career-page">
      <div className="border-b border-rule pb-5">
        <p className="eyebrow">Personal progression record</p>
        <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Career story</h2>
        <p className="mt-1.5 max-w-2xl text-base text-text-3">Your development, goals, and recognition presented as one connected record.</p>
      </div>

      <section className="grid grid-cols-2 divide-x divide-rule border-b border-rule sm:grid-cols-4" aria-label="Career totals">
        <div className="py-5 pr-3"><p className="fig text-2xl font-medium text-signal">{formatNumber(trainingHours)}h</p><p className="mt-1 text-sm text-text-3">training logged</p></div>
        <div className="py-5 pl-4 sm:pl-5"><p className="fig text-2xl font-medium text-text">{completedTraining}</p><p className="mt-1 text-sm text-text-3">courses complete</p></div>
        <div className="border-t border-rule py-5 pr-3 sm:border-t-0 sm:pl-5"><p className="fig text-2xl font-medium text-text">{recognitions.length}</p><p className="mt-1 text-sm text-text-3">recognitions</p></div>
        <div className="border-t border-rule py-5 pl-4 sm:border-t-0 sm:pl-5"><p className="fig text-2xl font-medium text-text">{activeGoals}</p><p className="mt-1 text-sm text-text-3">active goals</p></div>
      </section>

      <div className="grid gap-7 pt-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Career views">
          <p className="eyebrow mb-3">Career views</p>
          <div className="relative flex gap-1 overflow-x-auto border-b border-rule pb-2 lg:block lg:space-y-1 lg:overflow-visible lg:border-b-0 lg:border-l lg:pb-0 lg:pl-4">
            {TABS.map((item) => {
              const Icon = item.icon;
              const active = item.id === tab;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectTab(item.id)}
                  className={`relative flex shrink-0 items-center gap-2 rounded-sm px-3 py-2 text-left text-sm lg:w-full lg:px-2 ${active ? 'bg-signal/10 font-semibold text-signal' : 'text-text-3 hover:bg-panel-2 hover:text-text'}`}
                >
                  {active && <span className="absolute -bottom-[9px] left-2 right-2 h-0.5 bg-signal lg:-left-[17px] lg:bottom-auto lg:right-auto lg:h-6 lg:w-0.5" />}
                  <Icon className="h-4 w-4" />{item.label}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 animate-fade-up" key={tab}>
          {tab === 'development' && <Development />}
          {tab === 'recognition' && <Recognition />}
          {tab === 'overview' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-semibold text-text">Career timeline</h3>
                <p className="mt-1 text-sm text-text-3">The latest milestones across this career record.</p>
              </div>
              <Panel bodyClassName="p-0">
                {timeline.length === 0 ? (
                  <EmptyState icon={Sparkles} title="Your career story starts here" description="Add training, a goal, or recognition to build the timeline." />
                ) : timeline.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.id} className="row flex items-center gap-3 px-3 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-panel-2 text-signal">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text">{item.title}</p>
                        <p className="truncate text-xs text-text-3">{item.detail || item.type}</p>
                      </div>
                      <Badge tone="neutral">{item.type}</Badge>
                      <span className="fig hidden w-20 shrink-0 text-right text-2xs text-text-3 sm:block">{formatDTG(item.date)}</span>
                    </div>
                  );
                })}
              </Panel>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
