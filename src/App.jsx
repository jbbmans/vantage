import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import CommandCenter from '@/pages/CommandCenter';
import Activities from '@/pages/Activities';
import ActivityDetail from '@/pages/ActivityDetail';
import Work from '@/pages/Work';
import Goals from '@/pages/Goals';
import Career from '@/pages/Career';
import Team from '@/pages/Team';
import MemberDetail from '@/pages/MemberDetail';
import Login from '@/pages/Login';
import PasswordChangeRequired from '@/pages/PasswordChangeRequired';
import Readiness from '@/pages/Readiness';
import { Loader2 } from 'lucide-react';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider, Panel, EmptyState, Button } from '@/components/ui/primitives';
import { hydrate, useIdentity, useReady, useLoadError } from '@/store/useStore';

// Reports pulls in the charting library and Settings is an infrequent route.
// Neither belongs in the first paint, so both load on navigation.
const Reports = lazy(() => import('@/pages/Reports'));
const Settings = lazy(() => import('@/pages/Settings'));
const Units = lazy(() => import('@/pages/Units'));
const Help = lazy(() => import('@/pages/Help'));

function RouteFallback() {
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="h-8 w-48 animate-pulse rounded bg-panel-2" />
      <div className="panel h-40 rounded" />
      <div className="panel h-64 rounded" />
    </div>
  );
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

/** Server unreachable is a different problem from being signed out. */
function ServerGate({ children }) {
  const error = useLoadError();
  const identity = useIdentity();
  // Signed in with data on screen? A failed refresh is a banner inside the
  // shell (finding 44), not a full-screen takeover that hides the records.
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
    // A 401 anywhere in the app drops us back to the sign-in screen rather than
    // leaving a half-loaded shell showing stale records.
    const onSignedOut = () => hydrate();
    window.addEventListener('vantage:signed-out', onSignedOut);
    return () => window.removeEventListener('vantage:signed-out', onSignedOut);
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink p-4" role="status" aria-live="polite">
        <div className="flex items-center gap-3 text-text-2">
          <Loader2 className="h-5 w-5 animate-spin text-signal" aria-hidden />
          <span className="text-sm">Loading Vantage…</span>
        </div>
      </div>
    );
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
                  <Route path="activities" element={<Activities />} />
                  <Route path="activities/:id" element={<ActivityDetail />} />
                  <Route path="readiness" element={<Readiness />} />
                  <Route path="team" element={<Team />} />
                  {/* Role management now lives with its team; old bookmarks land there. */}
                  <Route path="roles" element={<Navigate to="/team" replace />} />
                  <Route path="units" element={<Suspense fallback={<RouteFallback />}><Units /></Suspense>} />
                  <Route path="team/:id" element={<MemberDetail />} />
                  <Route path="work" element={<Work />} />
                  <Route path="goals" element={<Goals />} />
                  <Route path="career" element={<Career />} />
                  {/* Old bookmarks keep working. */}
                  <Route path="development" element={<Navigate to="/career?tab=development" replace />} />
                  <Route path="recognition" element={<Navigate to="/career?tab=recognition" replace />} />
                  <Route path="help" element={<Suspense fallback={<RouteFallback />}><Help /></Suspense>} />
                  <Route path="reports" element={<Suspense fallback={<RouteFallback />}><Reports /></Suspense>} />
                  <Route path="settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />
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
