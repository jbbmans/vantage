import React, { Suspense, lazy, useEffect, useReducer, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import AppShell from '@/components/AppShell';
import Login from '@/pages/Login';
import PublicSite from '@/pages/PublicSite';
import ForcePasswordChange from '@/pages/ForcePasswordChange';
import Dashboard from '@/pages/Dashboard';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider, Skeleton, EmptyState, Button } from '@/components/ui/primitives';
import { useIdentity, keys } from '@/lib/queries';
import { hasSession, setupStatus } from '@/lib/api';
import { applyAccent, applyDensity, applyTheme, storedTheme } from '@/lib/theme';
import AppLoader from '@/components/AppLoader';
import { NAV_REDIRECTS } from '@/config/nav';

const Records = lazy(() => import('@/pages/Records'));
const RecordDetail = lazy(() => import('@/pages/RecordDetail'));
const WorkDetail = lazy(() => import('@/pages/WorkDetail'));
const WorkHub = lazy(() => import('@/pages/WorkHub'));
const Goals = lazy(() => import('@/pages/Goals'));
const Career = lazy(() => import('@/pages/Career'));
const Maradmins = lazy(() => import('@/pages/Maradmins'));
const Readiness = lazy(() => import('@/pages/Readiness'));
const ReportsHub = lazy(() => import('@/pages/ReportsHub'));
const Team = lazy(() => import('@/pages/Team'));
const MemberDetail = lazy(() => import('@/pages/MemberDetail'));
const Settings = lazy(() => import('@/pages/Settings'));
const Operator = lazy(() => import('@/pages/Operator'));
const Help = lazy(() => import('@/pages/Help'));

function Fallback() {
  return <div className="page space-y-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
}
const D = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<Fallback />}>{children}</Suspense>;

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
export const isPublicRoute = (pathname: string) => PUBLIC_ROUTES.includes(pathname);

function SignedOutHome({ serverError, onRetry }: { serverError: string | null; onRetry: () => void }) {
  const [state, setState] = useState<'loading' | 'setup' | 'public'>('loading');
  useEffect(() => {
    setupStatus().then((status) => setState(status.needsSetup ? 'setup' : 'public')).catch(() => setState('public'));
  }, []);
  if (state === 'loading') return <AppLoader />;
  if (state === 'setup') return <Login serverError={serverError} onRetry={onRetry} />;
  return <PublicSite />;
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
      // /display and /about are for anyone. A stale session marker whose /me comes back 401 used to
      // fire this and bounce a visitor reading the public page over to sign-in, which is the one
      // thing those routes promise will not happen.
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
  // A session that failed for any reason other than "not signed in" is an outage, not a sign-out.
  // Showing the marketing page to somebody who was working would look like their account vanished.
  const identityBroken = identity.isError && (identity.error as { status?: number })?.status !== 401;
  if (!publicStandalone && !signedOut && identity.isPending) return <AppLoader />;

  const serverError = identity.isError && (identity.error as { status?: number })?.status !== 401 ? (identity.error as Error).message : null;

  if (publicStandalone) {
    return <Routes><Route path="*" element={<PublicSite />} /></Routes>;
  }

  // An identity call that failed for a reason other than 401 goes to the sign-in screen carrying the
  // error and its retry, rather than falling through to the marketing page with no explanation.
  if (identityBroken) {
    return <Routes><Route path="*" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} /></Routes>;
  }

  if (signedOut || !identity.data) {
    return (
      <Routes>
        <Route path="/" element={<SignedOutHome serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/login" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/register" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/reset" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/invite" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="/setup" element={<Login serverError={serverError} onRetry={() => identity.refetch()} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (identity.data.user.must_change_password) {
    return <Routes><Route path="*" element={<ForcePasswordChange />} /></Routes>;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="records" element={<D><Records /></D>} />
        <Route path="records/:id" element={<D><RecordDetail /></D>} />
        {/* One task, project or goal on its own page — the surface a file and a conversation hang on. */}
        <Route path="records/:table/:id" element={<D><WorkDetail /></D>} />
        <Route path="work" element={<D><WorkHub /></D>} />
        <Route path="goals" element={<D><Goals /></D>} />
        <Route path="career" element={<D><Career /></D>} />
        <Route path="maradmins" element={<D><Maradmins /></D>} />
        <Route path="readiness" element={<D><Readiness /></D>} />
        <Route path="reports" element={<D><ReportsHub /></D>} />
        <Route path="team" element={<D><Team /></D>} />
        <Route path="team/:id" element={<D><MemberDetail /></D>} />
        <Route path="settings" element={<D><Settings /></D>} />
        <Route path="operator" element={<D><Operator /></D>} />
        <Route path="help" element={<D><Help /></D>} />
        {Object.entries(NAV_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from.slice(1)} element={<Navigate to={to} replace />} />
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

function RedirectRecord() {
  const id = window.location.pathname.split('/').pop();
  return <Navigate to={`/records/${id}`} replace />;
}
