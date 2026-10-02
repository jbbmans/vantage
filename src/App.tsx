import React, { Suspense, lazy, useEffect, useReducer, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import AppShell from '@/components/AppShell';
import Dashboard from '@/pages/Dashboard';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider, Skeleton, EmptyState, Button } from '@/components/ui/primitives';
import { useIdentity, keys } from '@/lib/queries';
import { hasSession, setupStatus, demoStart, errorText } from '@/lib/api';
import { applyAccent, applyDensity, applyTheme, storedTheme } from '@/lib/theme';
import AppLoader from '@/components/AppLoader';
import type { TeamSection } from '@/lib/teamAccess';
import { MOVED, movedTo } from '@/config/nav';
import { LINKS, consoleHref, siteHref } from '@/lib/links';

// Signed-out and one-off screens load on demand; a visitor to the public page gets public.html instead.
const Login = lazy(() => import('@/pages/Login'));
const PublicSite = lazy(() => import('@/pages/PublicSite'));
const ForcePasswordChange = lazy(() => import('@/pages/ForcePasswordChange'));
const RecordHub = lazy(() => import('@/pages/RecordHub'));
const WorkItemPage = lazy(() => import('@/pages/WorkItemPage'));
const RecordDetail = lazy(() => import('@/pages/RecordDetail'));
const WorkDetail = lazy(() => import('@/pages/WorkDetail'));
const Workbench = lazy(() => import('@/pages/Workbench'));
const Work = lazy(() => import('@/pages/Work'));
const Correspondence = lazy(() => import('@/pages/Correspondence'));
const Records = lazy(() => import('@/pages/Records'));
const Readiness = lazy(() => import('@/pages/Readiness'));
const Goals = lazy(() => import('@/pages/Goals'));
const Career = lazy(() => import('@/pages/Career'));
const Maradmins = lazy(() => import('@/pages/Maradmins'));
const ReportStudio = lazy(() => import('@/pages/ReportStudio'));
const Reports = lazy(() => import('@/pages/Reports'));
const Team = lazy(() => import('@/pages/Team'));
const MemberDetail = lazy(() => import('@/pages/MemberDetail'));
const Settings = lazy(() => import('@/pages/Settings'));
const DemoGovernance = lazy(() => import('@/pages/DemoGovernance'));
const Help = lazy(() => import('@/pages/Help'));
const Support = lazy(() => import('@/pages/Support'));
const Reference = lazy(() => import('@/pages/Reference'));

function Fallback() {
  return <div className="page space-y-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
}
const D = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<Fallback />}>{children}</Suspense>;
/** For whole-screen pages outside the shell, which have no skeleton of their own to show. */
const Screen = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<AppLoader />}>{children}</Suspense>;

function NotFound() {
  const navigate = useNavigate();
  return <div className="mx-auto max-w-md"><div className="card"><EmptyState title="No page here" description="That address does not match anything in Vantage." action={<Button onClick={() => navigate('/')}>Back to Dashboard</Button>} /></div></div>;
}

function NavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (e: Event) => navigate((e as CustomEvent<string>).detail);
    window.addEventListener('vantage:navigate', handler);
    return () => window.removeEventListener('vantage:navigate', handler);
  }, [navigate]);
  return null;
}

/** Routes that render the public page for anybody, signed in or not. */
const PUBLIC_ROUTES = ['/display', '/about'];
const isPublicRoute = (pathname: string) => PUBLIC_ROUTES.includes(pathname);

/** A page that lives on another host (the public site, the owner console): the browser goes there. */
function Elsewhere({ href, label }: { href: string; label: string }) {
  useEffect(() => { window.location.replace(href); }, [href]);
  return <AppLoader label={label} />;
}

/** The owner console is its own app; /operator, from old links and notifications, opens it at the same tab. */
function ToConsole() {
  const { search } = useLocation();
  return <Elsewhere href={consoleHref(`/${search}`)} label="Opening the owner console…" />;
}

/**
 * The server answers / with public.html for a signed-out visitor to a set-up instance, so the app only
 * reaches here for first-time setup or a session that turned out to have expired.
 */
function SignedOutHome({ serverError, onRetry }: { serverError: string | null; onRetry: () => void }) {
  const [state, setState] = useState<'loading' | 'setup' | 'public'>('loading');
  useEffect(() => {
    setupStatus().then((status) => setState(status.needsSetup ? 'setup' : 'public')).catch(() => setState('public'));
  }, []);
  if (state === 'loading') return <AppLoader />;
  // Where the public site has a host of its own, the application's front door is sign-in.
  return <Screen>{state === 'setup' || LINKS.site ? <Login serverError={serverError} onRetry={onRetry} /> : <PublicSite />}</Screen>;
}

let demoStarting: { attempt: number; promise: Promise<unknown> } | null = null;

function DemoEntry() {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    if (!demoStarting || demoStarting.attempt !== attempt) {
      const promise: Promise<unknown> = demoStart().finally(() => { if (demoStarting?.promise === promise) demoStarting = null; });
      demoStarting = { attempt, promise };
    }
    demoStarting.promise.catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [attempt]);
  if (!error) return <AppLoader label="Opening the synthetic demo" />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="card w-full max-w-md"><EmptyState title="The demo could not open" description={error} action={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>} /></div>
    </div>
  );
}

function useAccessMode(enabled: boolean) {
  const [mode, setMode] = useState<'accounts' | 'demo' | null>(null);
  useEffect(() => {
    if (!enabled) return;
    setupStatus().then((s) => setMode(s.accessMode === 'demo' ? 'demo' : 'accounts')).catch(() => setMode('accounts'));
  }, [enabled]);
  return mode;
}

function AppRoutes() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const identity = useIdentity();

  useEffect(() => {
    const onSignedIn = () => { rerender(); qc.invalidateQueries({ queryKey: keys.me }); };
    window.addEventListener('vantage:signed-in', onSignedIn);
    return () => window.removeEventListener('vantage:signed-in', onSignedIn);
  }, [qc]);

  useEffect(() => {
    applyTheme(storedTheme());
    const onSignedOut = () => {
      qc.removeQueries({ queryKey: keys.me });
      qc.clear();
      if (!isPublicRoute(window.location.pathname)) navigate('/login', { replace: true });
      rerender();
    };
    window.addEventListener('vantage:signed-out', onSignedOut);
    return () => window.removeEventListener('vantage:signed-out', onSignedOut);
  }, [navigate, qc]);

  useEffect(() => {
    const prefs = identity.data?.prefs;
    if (!prefs) return;
    if (prefs.theme) applyTheme(prefs.theme);
    if (prefs.accent) applyAccent(prefs.accent);
    applyDensity(prefs.density || 'comfortable');
  }, [identity.data?.prefs]);

  const signedOut = !hasSession() || (identity.isError && (identity.error as { status?: number })?.status === 401);
  const publicStandalone = isPublicRoute(location.pathname);
  const accessMode = useAccessMode(signedOut && !publicStandalone);
  const identityBroken = identity.isError && (identity.error as { status?: number })?.status !== 401;
  if (!publicStandalone && !signedOut && identity.isPending) return <AppLoader />;

  const serverError = identity.isError && (identity.error as { status?: number })?.status !== 401 ? (identity.error as Error).message : null;

  if (publicStandalone) {
    if (LINKS.site) return <Elsewhere href={siteHref(location.pathname)} label="Opening Vantage…" />;
    return <Routes><Route path="*" element={<Screen><PublicSite /></Screen>} /></Routes>;
  }

  if (identityBroken) {
    return <Routes><Route path="*" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} /></Routes>;
  }

  if (signedOut || !identity.data) {
    if (accessMode === null) return <AppLoader />;
    if (accessMode === 'demo') return <DemoEntry />;
    return (
      <Routes>
        <Route path="/" element={<SignedOutHome serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/login" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} />
        <Route path="/register" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} />
        <Route path="/reset" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} />
        <Route path="/invite" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} />
        <Route path="/setup" element={<Screen><Login serverError={serverError} onRetry={() => identity.refetch()} /></Screen>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (identity.data.user.must_change_password) {
    return <Routes><Route path="*" element={<Screen><ForcePasswordChange /></Screen>} /></Routes>;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="work" element={<Here />} />
        <Route path="work/queue" element={<D><Workbench /></D>} />
        <Route path="work/tasks" element={<D><Work section="tasks" /></D>} />
        <Route path="work/projects" element={<D><Work section="projects" /></D>} />
        <Route path="work/correspondence" element={<D><Correspondence /></D>} />
        <Route path="work/items/:id" element={<D><WorkItemPage /></D>} />
        <Route path="record" element={<Here><D><RecordHub section="overview" /></D></Here>} />
        <Route path="record/activities" element={<D><Records /></D>} />
        <Route path="record/drafts" element={<D><RecordHub section="drafts" /></D>} />
        <Route path="record/contributions" element={<D><RecordHub section="contributions" /></D>} />
        <Route path="records/:id" element={<D><RecordDetail /></D>} />
        <Route path="records/:table/:id" element={<D><WorkDetail /></D>} />
        <Route path="goals" element={<D><Goals /></D>} />
        <Route path="career" element={<Here><D><Career section="plan" /></D></Here>} />
        <Route path="career/training" element={<D><Career section="training" /></D>} />
        <Route path="career/awards" element={<D><Career section="awards" /></D>} />
        <Route path="career/counseling" element={<D><Career section="counseling" /></D>} />
        <Route path="career/readiness" element={<D><Readiness /></D>} />
        <Route path="reports" element={<Here><D><ReportStudio /></D></Here>} />
        <Route path="reports/analysis" element={<D><Reports /></D>} />
        <Route path="reference" element={<D><Reference /></D>} />
        <Route path="maradmins" element={<D><Maradmins /></D>} />
        <Route path="team" element={<Here><D><Team section="overview" /></D></Here>} />
        {TEAM_PAGES.map(([path, section]) => <Route key={path} path={`team/${path}`} element={<D><Team section={section} /></D>} />)}
        <Route path="team/:id" element={<D><MemberDetail /></D>} />
        <Route path="settings" element={<D><Settings /></D>} />
        <Route path="governance" element={<D><DemoGovernance /></D>} />
        <Route path="operator" element={<ToConsole />} />
        <Route path="help" element={<D><Help /></D>} />
        <Route path="support" element={<D><Support /></D>} />
        <Route path="support/:id" element={<D><Support /></D>} />
        {Object.keys(MOVED).map((from) => (
          <Route key={from} path={from.slice(1)} element={<Here />} />
        ))}
        <Route path="activities/:id" element={<RedirectRecord />} />
        {['login', 'register', 'reset', 'invite', 'setup'].map((path) => (
          <Route key={path} path={path} element={<Navigate to="/" replace />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <BrowserRouter>
          <NavigateBridge />
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </TooltipProvider>
  );
}

/** An address that moved (a tab that became a page, a page merged into another) goes where it lives now. */
function Here({ children }: { children?: React.ReactNode }) {
  const { pathname, search, hash } = useLocation();
  const target = movedTo(pathname, search);
  return target ? <Navigate to={`${target}${hash}`} replace /> : <>{children}</>;
}

const TEAM_PAGES: Array<[string, TeamSection]> = [['workload', 'workload'], ['roster', 'roster'], ['dashboard', 'dashboard'], ['invitations', 'invites'], ['roles', 'roles'], ['units', 'units'], ['access-log', 'audit']];

function RedirectRecord() {
  const id = window.location.pathname.split('/').pop();
  return <Navigate to={`/records/${id}`} replace />;
}
