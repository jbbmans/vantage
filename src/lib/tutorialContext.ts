import { createContext, useContext } from 'react';
import type { Tutorial, TutorialStep } from '@/config/tutorials';
import type { TutorialId } from '../../shared/tutorials';

/**
 * The tutorial being followed: which one, the steps offered to this person, and the step in view (its place among
 * those). `started` counts the times someone started a tutorial in this tab; it is 0 for one found open after a reload,
 * which takes no focus, since nobody just asked for it.
 */
export interface ActiveTutorial { tutorial: Tutorial; steps: TutorialStep[]; step: number; finished: boolean; started: number }

export interface Tutorials {
  /** Every tutorial this person may take, in the Field guide's order. Empty until the list has loaded. */
  offered: Tutorial[];
  /** The ones offered on the page in view. */
  here: Tutorial[];
  done: ReadonlySet<TutorialId>;
  /** Whether the line under a page's title offers its tutorials (Settings → Appearance). */
  prompts: boolean;
  active: ActiveTutorial | null;
  start: (id: TutorialId) => void;
  goTo: (step: number) => void;
  finish: () => void;
  close: () => void;
  /** The steps of a tutorial offered to this person: a reviewer's step only to a reviewer. */
  stepsOf: (tutorial: Tutorial) => TutorialStep[];
}

/**
 * Kept apart from the provider (src/lib/tutorials.tsx) so the page header can read it without loading the tutorials or
 * the shell: outside the application (the consoles, a print page) there is no provider, and nothing is offered.
 */
export const TutorialContext = createContext<Tutorials | null>(null);

export const useTutorials = () => useContext(TutorialContext);
