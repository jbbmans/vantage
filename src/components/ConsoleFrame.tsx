import React, { Suspense, lazy, useEffect, useReducer, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, LogOut, Moon, ShieldCheck, Sun, type LucideIcon } from 'lucide-react';
import Logo from '@/components/Logo';
import AppLoader from '@/components/AppLoader';
import ErrorBoundary from '@/components/ErrorBoundary';
import SudoDialog, { type SudoRequest } from '@/components/SudoDialog';
import IdleGuard from '@/components/IdleGuard';
import { ToastProvider } from '@/components/ui/toast';
import { Button, EmptyState, PageHeader, Skeleton, TooltipProvider } from '@/components/ui/primitives';
import { keys, queryClient, useIdentity, useSavePrefs, type Identity } from '@/lib/queries';
import { hasSession, logout } from '@/lib/api';
import { applyTheme, resolveTheme, storedTheme } from '@/lib/theme';
import { appHref } from '@/lib/links';
import { cn } from '@/lib/utils';

const Login = lazy(() => import('@/pages/Login'));

/**
 * The frame both consoles share: the owner console (an organization's owners and administrators) and the Vantage
 * admin dashboard (Vantage staff). Each is its own document with its own sign-in, and each admits only its audience.
 */
export interface ConsoleSection { path: string; label: string; icon: LucideIcon; title: string; lede: string; render: () => React.ReactElement; hidden?: boolean }

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;

/** Signs out of this console only. Its session is its own; the app, on its own address, stays signed in. */
export async function signOutOfConsole() {
  try { await logout(); } catch { /* signed out either way */ }
  queryClient.clear();
  window.dispatchEvent(new CustomEvent('vantage:signed-out'));
}

export function ConsoleFrame({ basename, documentTitle, loaderLabel, variant, admits, denied, children }: {
  basename: string;
  documentTitle: string;
  loaderLabel: string;
  variant: 'console' | 'admin';
  /** Whether this signed-in person is this console's audience. */
  admits: (identity: Identity) => boolean;
  denied: { title: string; description: string };
  children: (identity: Identity) => React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <ToastProvider>
        <BrowserRouter basename={basename}>
          <Gate documentTitle={documentTitle} loaderLabel={loaderLabel} variant={variant} admits={admits} denied={denied}>{children}</Gate>
        </BrowserRouter>
      </ToastProvider>
    </TooltipProvider>
  );
}

function Gate({ documentTitle, loaderLabel, variant, admits, denied, children }: Omit<Parameters<typeof ConsoleFrame>[0], 'basename'>) {
  const qc = useQueryClient();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const identity = useIdentity();
  useEffect(() => {
    applyTheme(storedTheme());
    const signedIn = () => { rerender(); qc.invalidateQueries({ queryKey: keys.me }); };
    const signedOut = () => { qc.clear(); rerender(); };
    window.addEventListener('vantage:signed-in', signedIn);
    window.addEventListener('vantage:signed-out', signedOut);
    return () => { window.removeEventListener('vantage:signed-in', signedIn); window.removeEventListener('vantage:signed-out', signedOut); };
  }, [qc]);
  useEffect(() => { document.title = documentTitle; }, [documentTitle]);
  useEffect(() => { if (identity.data?.prefs.theme) applyTheme(identity.data.prefs.theme); }, [identity.data?.prefs.theme]);

  const signedOut = !hasSession() || statusOf(identity.error) === 401;
  if (!signedOut && identity.isPending) return <AppLoader label={loaderLabel} />;
  if (signedOut || !identity.data) {
    const serverError = identity.isError && statusOf(identity.error) !== 401 ? (identity.error as Error).message : null;
    return <Suspense fallback={<AppLoader />}><Login variant={variant} serverError={serverError} onRetry={() => identity.refetch()} /></Suspense>;
  }
  const allowed = admits(identity.data);
  if (!allowed || identity.data.user.must_change_password) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas p-4">
        <div className="card w-full max-w-md">
          <EmptyState icon={ShieldCheck}
            title={allowed ? 'Set your own password first' : denied.title}
            description={allowed ? 'You signed in with a temporary password. Choose your own in the app, then come back.' : denied.description}
            action={<div className="flex gap-2"><Button variant="primary" onClick={() => window.location.assign(appHref('/'))}>Open the app</Button><Button variant="ghost" onClick={() => signOutOfConsole()}>Sign out</Button></div>} />
        </div>
      </div>
    );
  }
  return <>{children(identity.data)}</>;
}

/**
 * The console's chrome: a rail of sections, a header, and the page. `prefix` puts every section under a path of its
 * own (the owner console's organization); `context` sits under the logo (the organization switcher).
 */
export function ConsoleLayout({ identity, badge, railLabel, headerLabel, eyebrow, sections, prefix = '', context, banner }: {
  identity: Identity;
  badge: string;
  railLabel: string;
  headerLabel: React.ReactNode;
  eyebrow: string;
  sections: ConsoleSection[];
  prefix?: string;
  context?: React.ReactNode;
  banner?: React.ReactNode;
}) {
  const location = useLocation();
  const savePrefs = useSavePrefs();
  const [theme, setTheme] = useState(() => resolveTheme(identity.prefs.theme || storedTheme()));
  const [sudo, setSudo] = useState<SudoRequest | null>(null);
  useEffect(() => {
    const ask = (e: Event) => setSudo((e as CustomEvent<SudoRequest>).detail);
    window.addEventListener('vantage:sudo-required', ask);
    return () => window.removeEventListener('vantage:sudo-required', ask);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    // On a phone the sections are a strip wider than the screen; keep the one you are on in view.
    document.querySelector('[data-strip] a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [location.pathname]);

  const shown = sections.filter((s) => !s.hidden);
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); applyTheme(next); savePrefs.mutate({ theme: next }); };
  const who = [identity.user.rank?.abbr, identity.user.first_name, identity.user.last_name].filter(Boolean).join(' ');
  const to = (s: ConsoleSection) => `${prefix}/${s.path}`.replace(/\/$/, '') || '/';
  const link = (s: ConsoleSection, rail: boolean) => (
    <NavLink key={s.path} to={to(s)} end className={({ isActive }) => cn(rail ? 'nav-item' : 'shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-2 ring-1 ring-line', !rail && isActive && 'bg-accent text-accent-ink ring-accent')}>
      {rail && <s.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />}
      <span className="truncate">{s.label}</span>
    </NavLink>
  );

  return (
    <div className="flex min-h-[100dvh] bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className="sticky top-0 hidden h-[100dvh] w-64 shrink-0 flex-col border-r border-white/[.06] bg-rail lg:flex" aria-label={railLabel}>
        <div className="flex h-[60px] shrink-0 items-center gap-2 px-5">
          <Logo size={24} reversed />
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/80">{badge}</span>
        </div>
        {context && <div className="px-3 pb-3">{context}</div>}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label="Sections">{shown.map((s) => link(s, true))}</nav>
        <div className="border-t border-white/[.06] p-3">
          <p className="truncate px-2.5 text-sm font-medium text-white">{who}</p>
          <p className="truncate px-2.5 pb-2 text-xs text-white/50">{identity.user.username}</p>
          <a href={appHref('/')} className="nav-item"><ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={1.6} /><span>Open the app</span></a>
          <button type="button" onClick={() => signOutOfConsole()} className="nav-item w-full"><LogOut className="h-[18px] w-[18px]" strokeWidth={1.6} /><span>Sign out</span></button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-[60px] items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-8">
          <span className="flex items-center gap-2 lg:hidden"><Logo size={22} /><span className="text-xs font-semibold uppercase tracking-wider text-ink-3">{badge}</span></span>
          <span className="hidden min-w-0 truncate text-sm text-ink-3 lg:inline">{headerLabel}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={toggleTheme} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}>{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
            <a href={appHref('/')} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Open the app"><ArrowUpRight className="h-4 w-4" /></a>
            <button type="button" onClick={() => signOutOfConsole()} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        {context && <div className="border-b border-line bg-surface px-4 py-2 lg:hidden">{context}</div>}
        <nav data-strip className="flex gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2 lg:hidden" aria-label="Sections">{shown.map((s) => link(s, false))}</nav>
        {banner}

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-16 pt-7 outline-none sm:px-6 lg:px-10 lg:pt-10"><div className="page">
          <ErrorBoundary>
            <Routes>
              {shown.map((s) => (
                <Route key={s.path} path={to(s)} element={(
                  <>
                    <PageHeader eyebrow={eyebrow} title={s.title} lede={s.lede} />
                    <Suspense fallback={<Skeleton className="h-64" />}>{s.render()}</Suspense>
                  </>
                )} />
              ))}
              <Route path="*" element={<div className="card"><EmptyState title="No page here" description={`That address is not part of the ${railLabel.toLowerCase()}.`} action={<NavLink className="link" to={prefix || '/'}>Overview</NavLink>} /></div>} />
            </Routes>
          </ErrorBoundary>
        </div></main>
      </div>
      {/* A console session ends after 10 idle minutes; ask before it does. */}
      <IdleGuard onSignOut={() => { void signOutOfConsole(); }} />
      <SudoDialog open={Boolean(sudo)} onOpenChange={(o) => { if (!o) { sudo?.cancel(); setSudo(null); } }} onConfirmed={() => { const req = sudo; setSudo(null); req?.confirm(); }} />
    </div>
  );
}
