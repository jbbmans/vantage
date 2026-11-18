import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Tutorial, TutorialGate, TutorialStep } from '@/config/tutorials';
import { PERMISSIONS } from '../../shared/permissions';
import type { Prefs } from '../../shared/schemas';
import { isTutorialId, type TutorialId } from '../../shared/tutorials';
import * as api from '@/lib/api';
import { unitsWith, useIdentity, useSavePrefs } from '@/lib/queries';
import { useNav } from '@/lib/useNav';
import { onPage } from '@/lib/tutorialPaths';
import { TutorialContext, type ActiveTutorial, type Tutorials } from '@/lib/tutorialContext';

/**
 * The tutorials, read after the page has drawn rather than with it, as the list of changes is: every page would
 * otherwise carry their words in its first load, and most visits open none (src/components/WhatsNewDialog.tsx).
 */
export function useTutorialList() {
  return useQuery({
    queryKey: ['tutorials'],
    queryFn: () => import('@/config/tutorials').then((m) => m.TUTORIALS),
    staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: false,
  });
}

// The tutorial being followed, for this tab: it stays open across pages and a reload, and goes with the tab. The step
// is its place in the whole tutorial, not among the steps offered now: a View switch can change which are offered.
const OPEN = 'vantage.tutorial';
interface Stored { user: string; id: TutorialId; step: number }
function readOpen(user: string | undefined): Stored | null {
  if (!user) return null;
  try {
    const raw = JSON.parse(sessionStorage.getItem(OPEN) || 'null') as Partial<Stored> | null;
    return raw && raw.user === user && isTutorialId(raw.id) && Number.isInteger(raw.step) ? raw as Stored : null;
  } catch { return null; }
}
function writeOpen(value: Stored | null) {
  try { if (value) sessionStorage.setItem(OPEN, JSON.stringify(value)); else sessionStorage.removeItem(OPEN); } catch { /* a private window forgets it on reload; nothing else */ }
}

/**
 * Who a tutorial or a step is for: the menu's own rule (useNav's allowed), so a tutorial never leads to a page the menu
 * hides, and where a step needs more, a permission held in at least one unit. The server still decides every action.
 */
function useGate() {
  const { allowed } = useNav();
  const { data: identity } = useIdentity();
  return useCallback((gate?: TutorialGate) => {
    if (!gate) return true;
    if (!allowed(gate)) return false;
    if (gate.attachments && !identity?.instance.attachmentsEnabled) return false;
    if (gate.anyOf?.length && !gate.anyOf.some((key) => unitsWith(identity, PERMISSIONS[key]).length > 0)) return false;
    return true;
  }, [allowed, identity]);
}

export function TutorialProvider({ children }: { children: React.ReactNode }) {
  const { data: identity } = useIdentity();
  const userId = identity?.user?.id;
  const list = useTutorialList();
  const gate = useGate();
  const save = useSavePrefs();
  const { pathname, search } = useLocation();

  const offered = useMemo(() => (list.data || []).filter((t) => gate(t.when) && t.steps.some((s) => gate(s.when))), [list.data, gate]);
  const stepsOf = useCallback((t: Tutorial): TutorialStep[] => t.steps.filter((s) => gate(s.when)), [gate]);
  const here = useMemo(() => offered.filter((t) => t.pages.some((p) => onPage(p, pathname, search))), [offered, pathname, search]);
  const doneList = identity?.prefs?.tutorials?.done;
  const done = useMemo(() => new Set<TutorialId>((doneList || []).filter(isTutorialId)), [doneList]);
  const prompts = identity?.prefs?.tutorialPrompts !== false;

  // `step` is the step's place in the whole tutorial (tutorial.steps), whatever is offered now.
  const [open, setOpen] = useState<{ id: TutorialId; step: number; finished: boolean; started: number } | null>(null);
  const starts = useRef(0);
  // A reload, or the same person coming back to this tab, finds the tutorial where they left it. Nothing is written back
  // until it has been read, so the first pass cannot clear what it is about to restore.
  const [readFor, setReadFor] = useState<string | undefined>();
  useEffect(() => {
    const stored = readOpen(userId);
    setOpen(stored ? { id: stored.id, step: stored.step, finished: false, started: 0 } : null);
    setReadFor(userId);
  }, [userId]);
  useEffect(() => {
    if (userId && readFor === userId) writeOpen(open && !open.finished ? { user: userId, id: open.id, step: open.step } : null);
  }, [open, userId, readFor]);

  const active: ActiveTutorial | null = useMemo(() => {
    if (!open) return null;
    const tutorial = offered.find((t) => t.id === open.id);
    if (!tutorial) return null;
    const steps = stepsOf(tutorial);
    if (!steps.length) return null;
    // The step in view is the one stored, or, when it is not offered here (another View), the next one that is.
    const at = Math.min(Math.max(open.step, 0), tutorial.steps.length - 1);
    const next = steps.findIndex((s) => tutorial.steps.indexOf(s) >= at);
    return { tutorial, steps, step: next < 0 ? steps.length - 1 : next, finished: open.finished, started: open.started };
  }, [open, offered, stepsOf]);

  const start = useCallback((id: TutorialId) => { starts.current += 1; setOpen({ id, step: 0, finished: false, started: starts.current }); }, []);
  const goTo = useCallback((index: number) => setOpen((o) => {
    if (!o) return o;
    const tutorial = offered.find((t) => t.id === o.id);
    const target = tutorial ? stepsOf(tutorial)[index] : undefined;
    return target && tutorial ? { ...o, step: tutorial.steps.indexOf(target), finished: false } : o;
  }), [offered, stepsOf]);
  const close = useCallback(() => setOpen(null), []);
  const finish = useCallback(() => {
    if (!open) return;
    setOpen({ ...open, finished: true });
    const id = open.id;
    // Kept with what the server holds now, not only this tab's copy: another tab or device may have finished others.
    void api.api.get<Prefs>('/me/prefs').catch(() => null).then((held) => {
      const all = new Set<TutorialId>([...(held?.tutorials?.done ?? []).filter(isTutorialId), ...done, id]);
      save.mutate({ tutorials: { done: [...all] } });
    });
  }, [open, done, save]);

  const value: Tutorials = useMemo(() => ({ offered, here, done, prompts, active, start, goTo, finish, close, stepsOf }),
    [offered, here, done, prompts, active, start, goTo, finish, close, stepsOf]);
  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}
