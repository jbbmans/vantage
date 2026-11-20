import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Crosshair, GraduationCap, X } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { placeName } from '@/config/nav';
import type { TutorialStep } from '@/config/tutorials';
import { useTutorials } from '@/lib/tutorialContext';
import { hasParam, onPage } from '@/lib/tutorialPaths';
import { cn } from '@/lib/utils';

// "Show me": find the control a step is about, bring it into view and outline it

const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

/**
 * The control a step names, as it is on screen now: the first element tagged with that name that is shown. The same
 * name can tag two elements where a layout has two (the header's Log activity, and the tab bar's on a phone).
 */
export function findAnchor(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tutorial~="${CSS.escape(name)}"]`)) {
    if (!el.closest('[data-tutorial-panel]') && shown(el)) return el;
  }
  return null;
}

/** A page draws after its data arrives, so the control may come a moment after the page does. */
function waitForAnchor(name: string, ms: number, cancelled: () => boolean): Promise<HTMLElement | null> {
  const started = performance.now();
  return new Promise((resolve) => {
    const look = () => {
      if (cancelled()) return resolve(null);
      const el = findAnchor(name);
      if (el || performance.now() - started > ms) return resolve(el);
      window.setTimeout(look, 100);
    };
    look();
  });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let lit: HTMLElement | null = null;
let litTimer = 0;
function unlight() {
  window.clearTimeout(litTimer);
  lit?.classList.remove('tutorial-spot');
  lit = null;
}

/**
 * Scrolls the control to the middle of the screen and outlines it for a few seconds. A control that takes focus gets
 * it, so a keyboard or screen reader user lands on what the step is about and can act on it at once.
 */
function spotlight(el: HTMLElement): boolean {
  unlight();
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: still ? 'auto' : 'smooth' });
  el.classList.add('tutorial-spot');
  lit = el;
  litTimer = window.setTimeout(unlight, 4500);
  if (!el.matches(FOCUSABLE)) return false;
  el.focus({ preventScroll: true });
  return true;
}

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Whether something modal has the page: a form, a confirmation, a menu, the phone's menu drawer. Radix then turns off
 * pointer events on the body and hides the rest from assistive technology, the tutorial too, so the tutorial says it is
 * waiting rather than look as if its buttons work. Over a form or a confirmation its step stays readable above the dimmed
 * page; the phone's menu drawer covers it. A popover that is not modal (the bell) leaves it working, and is not counted.
 */
function useBlocked(panel: React.RefObject<HTMLElement | null>, watching: boolean): boolean {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    // Watched only while a tutorial is open: every dialog on every page would otherwise run this for nobody.
    if (!watching) { setBlocked(false); return; }
    const check = () => setBlocked(document.body.style.pointerEvents === 'none' || Boolean(panel.current?.closest('[aria-hidden="true"], [inert]')));
    check();
    // A modal's portal is added to the body and taken away, and the body's pointer events are turned off and on.
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true, attributes: true, attributeFilter: ['style'] });
    return () => watch.disconnect();
  }, [panel, watching]);
  return blocked;
}

/**
 * Where "Go to" leads for a step on another page, and how the menu names that place. A Marine's page is reached from
 * another: already there, "Go to" opens the step's tab of the same Marine's page; on the page it is reached from, there
 * is nowhere to go until the person opens one (null).
 */
function goal(step: TutorialStep, pathname: string, search: string): { to: string; name: string } | null {
  if (!hasParam(step.at)) return { to: step.at, name: step.place ?? placeName(step.at) };
  const [path, query] = step.at.split('?');
  if (query && onPage(path, pathname)) return { to: `${pathname}?${query}`, name: step.place ?? 'this tab' };
  if (!step.from || onPage(step.from, pathname, search)) return null;
  return { to: step.from, name: placeName(step.from) };
}

/** An element that may come a moment after the page it is on (a lazy page, a list still loading), given focus. */
function focusWhenThere(find: () => HTMLElement | null, ms: number) {
  const started = performance.now();
  const look = () => {
    const el = find();
    if (el) { if (!el.matches(FOCUSABLE)) el.setAttribute('tabindex', '-1'); el.scrollIntoView({ block: 'start' }); el.focus({ preventScroll: true }); return; }
    if (performance.now() - started < ms) window.setTimeout(look, 100);
    else document.getElementById('main')?.focus();
  };
  look();
}

/**
 * The tutorial being followed (ADR-0034). Not a dialog: it sits at the foot of the screen while the person does each
 * step in the application itself, and stays open from page to page. Every step is listed, so it is never a wizard: any
 * step can be opened, and the one in view says where it happens, takes you there and shows you the control.
 */
export default function TutorialPanel() {
  const t = useTutorials();
  const active = t?.active ?? null;
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const uid = useId();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [folded, setFolded] = useState(false);
  const [said, setSaid] = useState('');
  const [missing, setMissing] = useState<string | null>(null);
  // After "Go to", the control to show once its page has drawn.
  const [pending, setPending] = useState<string | null>(null);
  const run = useRef(0);
  // What opened the tutorial, to give focus back to when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const waiting = useBlocked(panel, Boolean(active));

  const say = useCallback((text: string) => { setSaid(''); window.requestAnimationFrame(() => setSaid(text)); }, []);
  const narrow = () => window.matchMedia?.('(max-width: 1023px)').matches;
  // Folded down to its heading, the steps are hidden: focus inside them goes to the button that unfolds it, not to the page.
  const foldDown = useCallback(() => {
    if (body.current?.contains(document.activeElement)) toggle.current?.focus();
    setFolded(true);
  }, []);

  const id = active?.tutorial.id;
  const started = active?.started ?? 0;
  // The start last acted on: a View switch can hide the tutorial and show it again, which is not a new start.
  const handled = useRef('');
  // Started (again), anything the last one was still doing is let go, and it opens unfolded unless the screen is too
  // short to show it beside the page. Started by the person, its heading takes focus so a screen reader says what
  // opened; found open after a reload, it leaves focus where the page put it.
  useEffect(() => {
    if (!id || handled.current === `${id}:${started}`) return;
    handled.current = `${id}:${started}`;
    run.current += 1;
    unlight();
    setPending(null);
    setMissing(null);
    setFolded(Boolean(window.matchMedia?.('(max-height: 480px)').matches));
    if (!started) return;
    const from = document.activeElement;
    opener.current = from instanceof HTMLElement && from !== document.body && !from.closest('[data-tutorial-panel]') ? from : null;
    heading.current?.focus();
  }, [id, started]);
  useEffect(() => { setMissing(null); }, [active?.step, pathname]);
  // On a screen too short to keep a control clear of the open panel (a phone on its side, a zoomed window), keyboard
  // focus moving to a control the panel covers folds it down to its heading, so the control is not hidden (WCAG 2.4.11).
  useEffect(() => {
    if (!active || folded) return;
    const moved = (e: FocusEvent) => {
      const el = e.target;
      const node = panel.current;
      if (!(el instanceof HTMLElement) || !node || node.contains(el) || !el.matches(':focus-visible') || el.closest('[role="dialog"], [role="alertdialog"]')) return;
      const rect = el.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      if (!rect.height || box.left >= rect.right || box.right <= rect.left) return;
      const header = document.querySelector<HTMLElement>('header.sticky');
      const top = header ? header.getBoundingClientRect().bottom : 0;
      // keepFocusClear keeps 12px either side of the control; less room than that above the panel, and it cannot.
      if (box.top - top < rect.height + 24) setFolded(true);
    };
    document.addEventListener('focusin', moved);
    return () => document.removeEventListener('focusin', moved);
  }, [active, folded]);
  useEffect(() => () => unlight(), []);

  // While it is open the page can scroll past it, and keyboard focus is kept out from under it (keepFocusClear).
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!active || !panel.current) { root.classList.remove('has-tutorial'); root.style.removeProperty('--tutorial'); return; }
    const node = panel.current;
    const measure = () => root.style.setProperty('--tutorial', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    measure();
    root.classList.add('has-tutorial');
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => { watch.disconnect(); root.classList.remove('has-tutorial'); root.style.removeProperty('--tutorial'); };
  }, [active]);

  const show = useCallback(async (step: TutorialStep, wait: number) => {
    if (!step.anchor) return;
    const mine = ++run.current;
    const el = await waitForAnchor(step.anchor, wait, () => mine !== run.current);
    if (mine !== run.current) return;
    if (!el) {
      setMissing(`${step.control ?? 'That'} is not on the page as it is now. The step says where to find it.`);
      say(`${step.control ?? 'That'} is not on the page as it is now.`);
      return;
    }
    setMissing(null);
    if (narrow()) foldDown();
    const focused = spotlight(el);
    // A control that takes no focus (a list, a panel) is only outlined; focus that had nowhere to stay waits on the panel.
    if (!focused && (!document.activeElement || document.activeElement === document.body)) heading.current?.focus();
    say(focused ? `Moved to ${step.control ?? 'the control'}. The tutorial stays open at the foot of the screen.` : `${step.control ?? 'It'} is outlined on the page.`);
    // A control the panel would cover is shown with the panel folded down to its heading.
    window.setTimeout(() => {
      if (mine === run.current && panel.current && overlaps(el.getBoundingClientRect(), panel.current.getBoundingClientRect())) foldDown();
    }, 500);
  }, [say, foldDown]);

  // Arrived where "Go to" led: show the control once it is there.
  useEffect(() => {
    if (!active || !pending) return;
    const step = active.steps[active.step];
    if (!step || step.anchor !== pending || !onPage(step.at, pathname, search)) return;
    setPending(null);
    void show(step, 4000);
  }, [active, pending, pathname, search, show]);

  if (!t || !active) return null;
  const { tutorial, steps, step: index, finished } = active;
  const step = steps[index];
  const here = onPage(step.at, pathname, search);
  const where = here ? null : goal(step, pathname, search);
  const last = index === steps.length - 1;

  const move = (to: number) => {
    run.current += 1;
    unlight();
    t.goTo(to);
    say(`Step ${to + 1} of ${steps.length}: ${steps[to].title}.`);
  };
  const close = () => {
    run.current += 1;
    unlight();
    t.close();
    const back = opener.current?.isConnected ? opener.current : document.getElementById('main');
    window.requestAnimationFrame(() => back?.focus());
  };
  const finish = () => {
    run.current += 1;
    unlight();
    t.finish();
    say(`You finished the ${tutorial.title} tutorial.`);
    // The steps give way to the end of the tutorial; focus goes to its heading rather than to the page.
    window.requestAnimationFrame(() => heading.current?.focus());
  };
  const go = () => {
    if (!where) return;
    run.current += 1;
    const [toPath, toQuery] = where.to.split('?');
    const arrives = onPage(step.at, toPath, toQuery ? `?${toQuery}` : '');
    if (step.anchor && arrives) setPending(step.anchor);
    // The button goes once its page is here; focus waits on the heading (the control takes it, if it can, when shown).
    // On a phone it folds to show the page, but only once nothing is left to read: with a control to find, show() folds
    // it when the control is there (a step that says it is not there is then seen, not only heard), and short of the
    // step's page, the step says where to go next.
    heading.current?.focus();
    if (narrow() && arrives && !step.anchor) setFolded(true);
    navigate(where.to);
    say(arrives ? `Now on ${where.name}.` : `Now on ${where.name}. Open the page the step names from here.`);
  };
  const others = () => {
    run.current += 1;
    unlight();
    t.close();
    navigate('/help#tutorials');
    // Help reads its anchor only when it opens, and may already be open: take the person to the list either way.
    focusWhenThere(() => document.querySelector<HTMLElement>('#tutorials h2'), 3000);
  };

  return (
    // A complementary landmark, not an <aside>: the rail's asides draw their focus ring in gold, which reads on navy only.
    <div ref={panel} role="complementary" aria-labelledby={`${uid}-title`} data-tutorial-panel="" data-folded={folded || undefined} data-waiting={(waiting && !finished) || undefined}
      className="tutorial-panel no-print card">
      <div className="flex items-start gap-2 border-b border-line px-4 pb-2.5 pt-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent-soft text-accent" aria-hidden><GraduationCap className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{finished ? 'Tutorial finished' : `Tutorial · step ${index + 1} of ${steps.length}`}</p>
          <h2 id={`${uid}-title`} ref={heading} tabIndex={-1} className="truncate text-md font-semibold text-ink outline-none">{tutorial.title}</h2>
        </div>
        <Button ref={toggle} variant="ghost" size="icon-sm" aria-expanded={!folded} aria-controls={`${uid}-body`} onClick={() => setFolded((f) => !f)}
          aria-label={folded ? 'Show the tutorial’s steps' : 'Fold the tutorial down'}>
          {folded ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close the tutorial" onClick={close}><X className="h-4 w-4" aria-hidden /></Button>
      </div>

      {waiting && !finished && <p className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-2">The tutorial waits while a window or menu is open. Finish or close it to go on.</p>}
      <div ref={body} id={`${uid}-body`} hidden={folded} className="tutorial-body">
        {finished ? (
          <div className="space-y-3 px-4 py-4 text-sm text-ink-2">
            <p className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden />You finished it. It stays in Help → Field guide, under Tutorials, to take again.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="default" onClick={close}>Close</Button>
              <Button size="sm" variant="ghost" asChild><Link to="/help#tutorials" onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); others(); }}>Other tutorials</Link></Button>
            </div>
          </div>
        ) : (
          <>
            <p className="px-4 pt-3 text-sm text-ink-2">{tutorial.outcome}</p>
            <ol className="px-2 py-2">
              {steps.map((s, i) => {
                const current = i === index;
                return (
                  <li key={s.title} aria-current={current ? 'step' : undefined} className={cn('rounded-sm', current && 'bg-surface-2')}>
                    <button type="button" onClick={() => move(i)} aria-expanded={current}
                      className="flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm">
                      <span className={cn('fig mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold', current ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2')}>{i + 1}</span>
                      <span className={cn('min-w-0 flex-1', current ? 'font-semibold text-ink' : 'text-ink-2')}>{s.title}</span>
                    </button>
                    {current && (
                      <div className="space-y-2.5 pb-3 pl-[2.375rem] pr-2">
                        <p className="text-sm leading-relaxed text-ink-2">{s.body}</p>
                        {!here && where && <Button size="sm" variant="default" onClick={go}>Go to {where.name}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>}
                        {here && s.anchor && <Button size="sm" variant="default" onClick={() => void show(s, 1500)}><Crosshair className="h-3.5 w-3.5" aria-hidden />Show me</Button>}
                        {here && !s.anchor && <p className="text-xs text-ink-3">You are on this step’s page.</p>}
                        {!here && !where && <p className="text-xs text-ink-3">Open the page this step names from here.</p>}
                        {missing && <p className="text-xs text-warn">{missing}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
              {/* Not disabled on the first step but marked so: a disabled button drops the focus it held (WCAG 2.4.3). */}
              <Button size="sm" variant="ghost" aria-disabled={index === 0 || undefined} className={cn(index === 0 && 'opacity-45')} onClick={() => { if (index > 0) move(index - 1); }}><ArrowLeft className="h-3.5 w-3.5" aria-hidden />Back</Button>
              {last
                ? <Button size="sm" variant="primary" onClick={finish}><Check className="h-3.5 w-3.5" aria-hidden />Finish</Button>
                : <Button size="sm" variant="primary" onClick={() => move(index + 1)}>Next<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>}
            </div>
          </>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{said}</p>
    </div>
  );
}
