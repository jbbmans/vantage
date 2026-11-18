import { Check, GraduationCap } from 'lucide-react';
import { useTutorials } from '@/lib/tutorialContext';

/**
 * The line under a page's title that offers the tutorials for what is done on that page (ADR-0034): guidance where the
 * task is, rather than one tour of everything. It names each tutorial and its length, marks the ones finished, and is
 * gone when there is none for this page, outside the application, or when the person turned the line off.
 */
export default function TutorialPrompt() {
  const t = useTutorials();
  if (!t || !t.prompts || !t.here.length) return null;
  return (
    <p className="no-print mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-2" data-tutorial-prompt="">
      <GraduationCap className="h-4 w-4 shrink-0 text-marker" aria-hidden />
      <span>{t.here.length === 1 ? 'Tutorial' : 'Tutorials'}</span>
      {t.here.map((tutorial) => {
        const finished = t.done.has(tutorial.id);
        const steps = t.stepsOf(tutorial).length;
        const label = `${tutorial.title}, ${steps} ${steps === 1 ? 'step' : 'steps'}`;
        return (
          // Named in one string: a flex item would put a stray pause in the name ("5 steps , finished").
          <button key={tutorial.id} type="button" onClick={() => t.start(tutorial.id)} aria-label={finished ? `${label}, finished` : label}
            className="link inline-flex min-h-6 items-center gap-1 font-medium">
            {label}
            {finished && <Check className="h-3.5 w-3.5" aria-hidden />}
          </button>
        );
      })}
    </p>
  );
}
