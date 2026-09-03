import React, { Suspense, lazy, useEffect, useReducer } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import AppShell from '@/components/AppShell';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider, Skeleton, EmptyState, Button } from '@/components/ui/primitives';
import { useIdentity, keys } from '@/lib/queries';
import { hasSession } from '@/lib/api';
import { applyAccent, applyDensity, applyTheme, storedTheme } from '@/lib/theme';
import AppLoader from '@/components/AppLoader';

const Records = lazy(() => import('@/pages/Records'));
const RecordDetail = lazy(() => import('@/pages/RecordDetail'));
const Work = lazy(() => import('@/pages/Work'));
const Goals = lazy(() => import('@/pages/Goals'));
const Career = lazy(() => import('@/pages/Career'));
const Readiness = lazy(() => import('@/pages/Readiness'));
const Reports = lazy(() => import('@/pages/Reports'));
const Team = lazy(() => import('@/pages/Team'));
const MemberDetail = lazy(() => import('@/pages/MemberDetail'));
const Maradmins = lazy(() => import('@/pages/Maradmins'));
const Settings = lazy(() => import('@/pages/Settings'));
const Operator = lazy(() => import('@/pages/Operator'));
const Help = lazy(() => import('@/pages/Help'));
const AiAssist = lazy(() => import('@/pages/AiAssist'));

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

export default function App() {
  const qc = useQueryClient();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const identity = useIdentity();
  useEffect(() => {
    const onSignedIn = () => { rerender(); qc.invalidateQueries({ queryKey: keys.me }); };
    window.addEventListener('vantage:signed-in', onSignedIn);
    return () => window.removeEventListener('vantage:signed-in', onSignedIn);
  }, [qc]);

  useEffect(() => {
    applyTheme(storedTheme());
    const onSignedOut = () => { qc.removeQueries({ queryKey: keys.me }); qc.clear(); rerender(); };
    window.addEventListener('vantage:signed-out', onSignedOut);
    return () => window.removeEventListener('vantage:signed-out', onSignedOut);
  }, [qc]);

  useEffect(() => {
    const prefs = identity.data?.prefs;
    if (!prefs) return;
    if (prefs.theme) applyTheme(prefs.theme);
    if (prefs.accent) applyAccent(prefs.accent);
    applyDensity(prefs.density || 'comfortable');
  }, [identity.data?.prefs]);

  const signedOut = !hasSession() || (identity.isError && (identity.error as { status?: number })?.status === 401);
  if (!signedOut && identity.isPending) return <AppLoader />;

  return (
    <TooltipProvider>
      <ToastProvider>
        <BrowserRouter>
          <NavigateBridge />
          {signedOut || !identity.data ? (
            <Routes>
              <Route path="*" element={<Login serverError={identity.isError && (identity.error as { status?: number })?.status !== 401 ? (identity.error as Error).message : null} onRetry={() => identity.refetch()} />} />
            </Routes>
          ) : (
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Dashboard />} />
                <Route path="records" element={<D><Records /></D>} />
                <Route path="records/:id" element={<D><RecordDetail /></D>} />
                <Route path="work" element={<D><Work /></D>} />
                <Route path="goals" element={<D><Goals /></D>} />
                <Route path="career" element={<D><Career /></D>} />
                <Route path="readiness" element={<D><Readiness /></D>} />
                <Route path="reports" element={<D><Reports /></D>} />
                <Route path="team" element={<D><Team /></D>} />
                <Route path="team/:id" element={<D><MemberDetail /></D>} />
                <Route path="maradmins" element={<D><Maradmins /></D>} />
                <Route path="assist" element={<D><AiAssist /></D>} />
                <Route path="settings" element={<D><Settings /></D>} />
                <Route path="operator" element={<D><Operator /></D>} />
                <Route path="help" element={<D><Help /></D>} />
                <Route path="activities" element={<Navigate to="/records" replace />} />
                <Route path="activities/:id" element={<RedirectRecord />} />
                <Route path="login" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          )}
        </BrowserRouter>
      </ToastProvider>
    </TooltipProvider>
  );
}

function RedirectRecord() {
  const id = window.location.pathname.split('/').pop();
  return <Navigate to={`/records/${id}`} replace />;
}
