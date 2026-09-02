import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import CommandCenter from '@/pages/CommandCenter';
import Login from '@/pages/Login';
import PasswordChangeRequired from '@/pages/PasswordChangeRequired';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider, Panel, EmptyState, Button } from '@/components/ui/primitives';
import { hydrate, useIdentity, useReady, useLoadError } from '@/store/useStore';
import AppLoader from '@/components/AppLoader';

const Reports = lazy(() => import('@/pages/Reports'));
const Settings = lazy(() => import('@/pages/Settings'));
const Units = lazy(() => import('@/pages/Units'));
const Help = lazy(() => import('@/pages/Help'));
const Maradmins = lazy(() => import('@/pages/Maradmins'));
const OperatorConsole = lazy(() => import('@/pages/OperatorConsole'));
const Activities = lazy(() => import('@/pages/Activities'));
const ActivityDetail = lazy(() => import('@/pages/ActivityDetail'));
const Work = lazy(() => import('@/pages/Work'));
const Goals = lazy(() => import('@/pages/Goals'));
const AiAssist = lazy(() => import('@/pages/AiAssist'));
const Career = lazy(() => import('@/pages/Career'));
const Team = lazy(() => import('@/pages/Team'));
const MemberDetail = lazy(() => import('@/pages/MemberDetail'));
const Readiness = lazy(() => import('@/pages/Readiness'));

function RouteFallback() {
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="skeleton h-8 w-48 rounded" />
      <div className="skeleton h-40 rounded" />
      <div className="skeleton h-64 rounded" />
    </div>
  );
}

function Deferred({ children }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md">
      <Panel>
        <EmptyState
          title="No page here"
          description="That address doesn't match anything in Vantage."
          action={<Button size="sm" asChild><a href="/">Back to Command Center</a></Button>}
        />
      </Panel>
    </div>
  );
}

function ServerGate({ children }) {
  const error = useLoadError();
  const identity = useIdentity();
  if (!error || identity) return children;
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <div className="panel max-w-md rounded p-5">
        <h1 className="text-lg font-semibold text-text">Can't reach the server</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-2">{error.message}</p>
        <p className="mt-3 text-xs leading-relaxed text-text-3">
          Vantage keeps records on your command's server so authorized members of the selected unit can see shared
          work. Without a connection there's nothing to read.
        </p>
        <Button size="sm" className="mt-4" onClick={() => window.location.reload()}>Try again</Button>
      </div>
    </div>
  );
}

export default function App() {
  const identity = useIdentity();
  const ready = useReady();

  useEffect(() => {
    hydrate();
    const onSignedOut = () => hydrate();
    window.addEventListener('vantage:signed-out', onSignedOut);
    return () => window.removeEventListener('vantage:signed-out', onSignedOut);
  }, []);

  if (!ready) {
    return <AppLoader />;
  }

  return (
    <TooltipProvider>
      <ToastProvider>
        <ServerGate>
          {!identity ? (
            <Login />
          ) : identity.user?.must_change_password ? (
            <PasswordChangeRequired />
          ) : (
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<CommandCenter />} />
                  <Route path="activities" element={<Deferred><Activities /></Deferred>} />
                  <Route path="activities/:id" element={<Deferred><ActivityDetail /></Deferred>} />
                  <Route path="readiness" element={<Deferred><Readiness /></Deferred>} />
                  <Route path="team" element={<Deferred><Team /></Deferred>} />
                  <Route path="roles" element={<Navigate to="/team" replace />} />
                  <Route path="units" element={<Deferred><Units /></Deferred>} />
                  <Route path="team/:id" element={<Deferred><MemberDetail /></Deferred>} />
                  <Route path="work" element={<Deferred><Work /></Deferred>} />
                  <Route path="goals" element={<Deferred><Goals /></Deferred>} />
                  <Route path="ai" element={<Deferred><AiAssist /></Deferred>} />
                  <Route path="career" element={<Deferred><Career /></Deferred>} />
                  <Route path="maradmins" element={<Deferred><Maradmins /></Deferred>} />
                  <Route path="development" element={<Navigate to="/career?tab=development" replace />} />
                  <Route path="recognition" element={<Navigate to="/career?tab=recognition" replace />} />
                  <Route path="help" element={<Deferred><Help /></Deferred>} />
                  <Route path="reports" element={<Deferred><Reports /></Deferred>} />
                  <Route path="settings" element={<Deferred><Settings /></Deferred>} />
                  <Route path="operator" element={<Deferred><OperatorConsole /></Deferred>} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </BrowserRouter>
          )}
        </ServerGate>
      </ToastProvider>
    </TooltipProvider>
  );
}
