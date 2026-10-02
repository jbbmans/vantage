import React, { Suspense, lazy, useEffect, useReducer, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity, Archive, ArrowUpRight, BarChart3, Building2, Database, Gauge, IdCard, LogOut, Mail, Moon, ScrollText, Settings2, ShieldCheck, Sparkles, Sun, Users,
  type LucideIcon,
} from 'lucide-react';
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
import { appHref, LINKS } from '@/lib/links';
import { cn } from '@/lib/utils';
import * as Sections from './sections';

const Login = lazy(() => import('@/pages/Login'));

interface Section { path: string; tab: string; label: string; icon: LucideIcon; title: string; lede: string; render: () => React.ReactElement }

/** The console's pages. `tab` is the old /operator?tab= name, so links written before the console moved still land. */
const SECTIONS: Section[] = [
  { path: '', tab: 'overview', label: 'Overview', icon: Gauge, title: 'This deployment', lede: 'Accounts, records, the database, email and the integrity of the audit chain at a glance.', render: () => <Sections.Overview /> },
  { path: 'settings', tab: 'settings', label: 'Settings', icon: Settings2, title: 'Settings', lede: 'What everyone sees: the instance name, sign-up, maintenance and the announcement on the sign-in page.', render: () => <Sections.RuntimeSettings /> },
  { path: 'ai', tab: 'ai', label: 'AI', icon: Sparkles, title: 'AI assistance', lede: 'GenAI.mil models, budgets, and whether AI is offered at all.', render: () => <Sections.AiSettings /> },
  { path: 'metrics', tab: 'metrics', label: 'Metrics', icon: BarChart3, title: 'Metrics', lede: 'The value types and categories every record is counted in.', render: () => <Sections.MetricsSettings /> },
  { path: 'accounts', tab: 'users', label: 'Accounts', icon: Users, title: 'Accounts', lede: 'Everyone with an account: sign-in details, temporary passwords, CAC links and owner rights.', render: () => <Sections.Accounts /> },
  { path: 'units', tab: 'units', label: 'Units', icon: Building2, title: 'Units', lede: 'Every unit on the instance and who owns it.', render: () => <Sections.UnitsAdmin /> },
  { path: 'email', tab: 'email', label: 'Email', icon: Mail, title: 'Email', lede: 'How this deployment sends mail, and what it has sent.', render: () => <Sections.EmailConsole /> },
  { path: 'personnel', tab: 'personnel', label: 'Personnel', icon: IdCard, title: 'Personnel feed', lede: 'The roster that keeps names, ranks and EAS dates current.', render: () => <Sections.PersonnelConsole /> },
  { path: 'retention', tab: 'retention', label: 'Retention', icon: Archive, title: 'Retention and holds', lede: 'How long records are kept, and the legal holds that stop anything being destroyed.', render: () => <Sections.RetentionConsole /> },
  { path: 'privacy', tab: 'privacy', label: 'Privacy', icon: ShieldCheck, title: 'Privacy inventory', lede: 'What personal information Vantage holds, and why.', render: () => <Sections.PrivacyConsole /> },
  { path: 'usage', tab: 'usage', label: 'Usage', icon: Activity, title: 'Usage and reliability', lede: 'How Vantage is used and where it fails, without anyone’s content.', render: () => <Sections.UsageConsole /> },
  { path: 'audit', tab: 'audit', label: 'Audit log', icon: ScrollText, title: 'Audit log', lede: 'Every sensitive action, in a tamper-evident chain.', render: () => <Sections.AuditLog /> },
  { path: 'data', tab: 'data', label: 'Backup and move', icon: Database, title: 'Backup and move', lede: 'Download a backup, or move the whole instance to another host.', render: () => <Sections.DataAdmin /> },
];

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;

/** Signs out of the console only. Its session is its own; the app, on its own address, stays signed in. */
async function signOut() {
  try { await logout(); } catch { /* signed out either way */ }
  queryClient.clear();
  window.dispatchEvent(new CustomEvent('vantage:signed-out'));
}

export default function ConsoleApp() {
  return (
    <TooltipProvider>
      <ToastProvider>
        {/* One address for everything puts the console under /console; a host of its own puts it at the root. */}
        <BrowserRouter basename={LINKS.split && !LINKS.console.endsWith('/console') ? '/' : '/console'}>
          <Gate />
        </BrowserRouter>
      </ToastProvider>
    </TooltipProvider>
  );
}

/** Signed out: the owners' sign-in. Signed in but not an owner: told so. An owner: the console. */
function Gate() {
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
  useEffect(() => { document.title = 'Owner console | Vantage'; }, []);
  useEffect(() => { if (identity.data?.prefs.theme) applyTheme(identity.data.prefs.theme); }, [identity.data?.prefs.theme]);

  const signedOut = !hasSession() || statusOf(identity.error) === 401;
  if (!signedOut && identity.isPending) return <AppLoader label="Opening the owner console…" />;
  if (signedOut || !identity.data) {
    const serverError = identity.isError && statusOf(identity.error) !== 401 ? (identity.error as Error).message : null;
    return <Suspense fallback={<AppLoader />}><Login variant="console" serverError={serverError} onRetry={() => identity.refetch()} /></Suspense>;
  }
  const user = identity.data.user;
  if (!user.is_operator || user.must_change_password) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas p-4">
        <div className="card w-full max-w-md">
          <EmptyState icon={ShieldCheck}
            title={user.is_operator ? 'Set your own password first' : 'This is the owner console'}
            description={user.is_operator ? 'You signed in with a temporary password. Choose your own in the app, then come back.' : 'Only the people who run this Vantage can use it. Your work is in the app.'}
            action={<div className="flex gap-2"><Button variant="primary" onClick={() => window.location.assign(appHref('/'))}>Open the app</Button><Button variant="ghost" onClick={() => signOut()}>Sign out</Button></div>} />
        </div>
      </div>
    );
  }
  return <Shell identity={identity.data} />;
}

function Shell({ identity }: { identity: Identity }) {
  const location = useLocation();
  const [params] = useSearchParams();
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

  // /?tab=users, from a bookmark or a notification written before the console had pages of its own.
  const legacy = SECTIONS.find((s) => s.tab === params.get('tab'));
  if (legacy && location.pathname === '/') return <Navigate to={`/${legacy.path}`} replace />;

  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); applyTheme(next); savePrefs.mutate({ theme: next }); };
  const who = [identity.user.rank?.abbr, identity.user.first_name, identity.user.last_name].filter(Boolean).join(' ');
  const instance = identity.instance?.displayName || 'Vantage';
  const link = (s: Section, rail: boolean) => (
    <NavLink key={s.path} to={`/${s.path}`} end className={({ isActive }) => cn(rail ? 'nav-item' : 'shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-2 ring-1 ring-line', !rail && isActive && 'bg-accent text-accent-ink ring-accent')}>
      {rail && <s.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.6} />}
      <span className="truncate">{s.label}</span>
    </NavLink>
  );

  return (
    <div className="flex min-h-[100dvh] bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className="sticky top-0 hidden h-[100dvh] w-64 shrink-0 flex-col border-r border-white/[.06] bg-rail lg:flex" aria-label="Owner console">
        <div className="flex h-[60px] shrink-0 items-center gap-2 px-5">
          <Logo size={24} reversed />
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/80">Owner</span>
        </div>
        <p className="px-5 pb-3 text-xs text-white/50">{instance}</p>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label="Sections">{SECTIONS.map((s) => link(s, true))}</nav>
        <div className="border-t border-white/[.06] p-3">
          <p className="truncate px-2.5 text-sm font-medium text-white">{who}</p>
          <p className="truncate px-2.5 pb-2 text-xs text-white/50">{identity.user.username}</p>
          <a href={appHref('/')} className="nav-item"><ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={1.6} /><span>Open the app</span></a>
          <button type="button" onClick={() => signOut()} className="nav-item w-full"><LogOut className="h-[18px] w-[18px]" strokeWidth={1.6} /><span>Sign out</span></button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-[60px] items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-8">
          <span className="flex items-center gap-2 lg:hidden"><Logo size={22} /><span className="text-xs font-semibold uppercase tracking-wider text-ink-3">Owner</span></span>
          <span className="hidden text-sm text-ink-3 lg:inline">Owner console · {instance}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={toggleTheme} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}>{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
            <a href={appHref('/')} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Open the app"><ArrowUpRight className="h-4 w-4" /></a>
            <button type="button" onClick={() => signOut()} className="rounded-lg p-2 text-ink-3 hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <nav data-strip className="flex gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2 lg:hidden" aria-label="Sections">{SECTIONS.map((s) => link(s, false))}</nav>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-16 pt-7 outline-none sm:px-6 lg:px-10 lg:pt-10"><div className="page">
          <ErrorBoundary>
            <Routes>
              {SECTIONS.map((s) => (
                <Route key={s.path} path={`/${s.path}`} element={(
                  <>
                    <PageHeader eyebrow="Owner console" title={s.title} lede={s.lede} />
                    <Suspense fallback={<Skeleton className="h-64" />}>{s.render()}</Suspense>
                  </>
                )} />
              ))}
              <Route path="*" element={<div className="card"><EmptyState title="No page here" description="That address is not part of the owner console." action={<NavLink className="link" to="/">Overview</NavLink>} /></div>} />
            </Routes>
          </ErrorBoundary>
        </div></main>
      </div>
      {/* An owner's session ends after 10 idle minutes; ask before it does. */}
      <IdleGuard onSignOut={() => { void signOut(); }} />
      <SudoDialog open={Boolean(sudo)} onOpenChange={(o) => { if (!o) { sudo?.cancel(); setSudo(null); } }} onConfirmed={() => { const req = sudo; setSudo(null); req?.confirm(); }} />
    </div>
  );
}
