import { Check, GraduationCap } from 'lucide-react';
import { Badge, Button, Panel, Skeleton } from '@/components/ui/primitives';
import type { Tutorial, TutorialStep } from '@/config/tutorials';
import { useTutorials, type Tutorials } from '@/lib/tutorialContext';

/**
 * The tutorials whose words hold every word of the search, the ones named in their title first. Only the steps this
 * person is offered count (`stepsOf`): a step they are not shown never makes a tutorial match.
 */
export function searchTutorials(query: string, list: Tutorial[], stepsOf: (t: Tutorial) => TutorialStep[]): Tutorial[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return list
    .map((t) => {
      const title = t.title.toLowerCase();
      const hay = `${title} ${t.outcome} ${t.keywords ?? ''} ${stepsOf(t).map((s) => `${s.title} ${s.body}`).join(' ')}`.toLowerCase();
      return { t, all: terms.every((w) => hay.includes(w)), score: terms.reduce((n, w) => n + (title.includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((r) => r.all)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.t);
}

function Row({ tutorial, t }: { tutorial: Tutorial; t: Tutorials }) {
  const steps = t.stepsOf(tutorial).length;
  const finished = t.done.has(tutorial.id);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-2 text-md font-medium text-ink">
          {tutorial.title}
          {finished && <Badge tone="good"><Check className="h-3 w-3" aria-hidden />Finished</Badge>}
        </p>
        <p className="mt-0.5 text-sm text-ink-2">{tutorial.outcome}</p>
      </div>
      <span className="fig text-xs text-ink-3">{steps} {steps === 1 ? 'step' : 'steps'}</span>
      <Button size="sm" variant={finished ? 'ghost' : 'default'} onClick={() => t.start(tutorial.id)} aria-label={`${finished ? 'Take again' : 'Start'}: ${tutorial.title}`}>
        {finished ? 'Take again' : 'Start'}
      </Button>
    </li>
  );
}

/**
 * The Field guide's list of tutorials (ADR-0034): every one this person may take, each with what it gets done and how
 * long it is. Given `only`, the ones a search found. Each opens beside the page and leads to the screens it is about.
 */
export default function TutorialList({ only }: { only?: Tutorial[] }) {
  const t = useTutorials();
  if (!t) return null;
  const list = only ?? t.offered;
  if (only && !only.length) return null;
  return (
    <Panel id={only ? undefined : 'tutorials'} title={only ? `${list.length} ${list.length === 1 ? 'tutorial' : 'tutorials'}` : 'Tutorials'}
      subtitle={only ? undefined : 'Short, and one task each. A tutorial opens beside the page and takes you to the screens it is about, so you do the task as you read it.'}
      bodyClassName="p-0">
      {list.length
        ? <ul className="divide-y divide-line">{list.map((tutorial) => <Row key={tutorial.id} tutorial={tutorial} t={t} />)}</ul>
        : (
          <div className="flex items-center gap-3 px-4 py-4" aria-busy="true">
            <GraduationCap className="h-4 w-4 text-ink-3" aria-hidden />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
    </Panel>
  );
}
