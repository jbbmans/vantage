import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, ArrowRight, Award, BookOpen, FileBarChart, Target } from 'lucide-react';
import Development from '@/pages/Development';
import Recognition from '@/pages/Recognition';
import { useGoals, useRecognitions, useTrainings } from '@/store/useStore';
import { formatNumber } from '@/lib/metrics';

/**
 * Training and recognition are two views of the same thing — what your career
 * file says about you — and they were two nav items doing one job. Merged, and
 * the tab survives a refresh because it lives in the URL.
 */
export default function Career() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'recognition' ? 'recognition' : 'development';
  const trainings = useTrainings();
  const recognitions = useRecognitions();
  const goals = useGoals();
  const trainingHours = trainings.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);
  const completedTraining = trainings.filter((item) => item.status === 'completed').length;
  const activeGoals = goals.filter((goal) => goal.status === 'active').length;

  const INDEX = [
    { label: 'Training & PME', icon: BookOpen, active: tab === 'development', onClick: () => setParams({ tab: 'development' }, { replace: true }) },
    { label: 'Recognition', icon: Award, active: tab === 'recognition', onClick: () => setParams({ tab: 'recognition' }, { replace: true }) },
  ];

  return (
    <div className="page-canvas career-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Personal progression record</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Career story</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">A chronological view of training, qualifications, recognition, readiness, goals, and package-ready accomplishments.</p>
        </div>
      </div>

      <section className="grid grid-cols-2 divide-x divide-rule border-b border-rule sm:grid-cols-4" aria-label="Career totals">
        <div className="py-5"><p className="fig text-2xl font-medium text-signal">{formatNumber(trainingHours)}h</p><p className="mt-1 text-sm text-text-3">training logged</p></div>
        <div className="py-5 pl-5"><p className="fig text-2xl font-medium text-text">{completedTraining}</p><p className="mt-1 text-sm text-text-3">courses complete</p></div>
        <div className="py-5 pl-5"><p className="fig text-2xl font-medium text-text">{recognitions.length}</p><p className="mt-1 text-sm text-text-3">recognitions</p></div>
        <div className="py-5 pl-5"><p className="fig text-2xl font-medium text-text">{activeGoals}</p><p className="mt-1 text-sm text-text-3">active goals</p></div>
      </section>

      <div className="grid gap-7 pt-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Career index">
          <p className="eyebrow mb-3">Career index</p>
          <div className="relative space-y-1 border-l border-rule pl-4">
            {INDEX.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.label} type="button" onClick={item.onClick} className={`relative flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm ${item.active ? 'bg-signal/10 font-semibold text-signal' : 'text-text-3 hover:bg-panel-2 hover:text-text'}`}>
                  {item.active && <span className="absolute -left-[17px] h-6 w-0.5 bg-signal" />}
                  <Icon className="h-4 w-4" />{item.label}
                </button>
              );
            })}
            <Link to="/readiness" className="flex items-center gap-2 rounded-sm px-2 py-2 text-sm text-text-3 hover:bg-panel-2 hover:text-text"><Activity className="h-4 w-4" />Readiness</Link>
            <Link to="/goals" className="flex items-center gap-2 rounded-sm px-2 py-2 text-sm text-text-3 hover:bg-panel-2 hover:text-text"><Target className="h-4 w-4" />Goals</Link>
            <Link to="/reports" className="flex items-center gap-2 rounded-sm px-2 py-2 text-sm text-text-3 hover:bg-panel-2 hover:text-text"><FileBarChart className="h-4 w-4" />Package builder</Link>
          </div>
          <Link to="/reports" className="mt-5 flex items-center gap-1 text-sm text-text-3 hover:text-signal">Open reports <ArrowRight className="h-4 w-4" /></Link>
        </aside>
        <main className="min-w-0">
          {tab === 'development' ? <Development /> : <Recognition />}
        </main>
      </div>
    </div>
  );
}
