import { track } from '@/lib/telemetry';
import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

interface State { error: Error | null }

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string; full?: boolean }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Vantage page error', error, info.componentStack);
    track('reliability.client_error', { surface: surfaceOf(window.location.pathname), recovered: false });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    const stale = /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically/i.test(message);
    return (
      <div className={this.props.full ? 'flex min-h-screen items-center justify-center bg-canvas p-6' : 'page'}>
        <div className="card mx-auto max-w-lg p-6 text-center" role="alert">
          <div className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${stale ? 'bg-accent/10 text-accent ring-accent/25' : 'bg-bad/10 text-bad ring-bad/30'}`}>{stale ? <RefreshCw className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}</div>
          <h1 className="text-lg font-semibold text-ink">{stale ? 'Vantage was updated' : 'This page hit an error'}</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">{stale ? 'A newer version was published while this tab was open. Reload to use it; nothing you saved is affected.' : 'Your records are safe; nothing was changed. Try the page again, reload, or go back to Today.'}</p>
          {!stale && <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-surface-2 p-2 text-left font-mono text-2xs text-ink-3 ring-1 ring-inset ring-line">{message}</pre>}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {!stale && !this.props.full && <Button onClick={() => this.setState({ error: null })}>Try again</Button>}
            <Button variant={stale ? 'primary' : 'default'} onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" />Reload</Button>
            {!stale && <Button variant="primary" onClick={() => { window.location.assign('/'); }}><Home className="h-4 w-4" />Today</Button>}
          </div>
        </div>
      </div>
    );
  }
}

function surfaceOf(pathname: string): string {
  const segment = pathname.split('/')[1] || '';
  const known = ['records', 'queue', 'goals', 'correspondence', 'studio', 'reports', 'career', 'readiness', 'team', 'settings', 'operator', 'help', 'reference'];
  if (segment === 'work') return 'tasks';
  return known.includes(segment) ? segment : 'dashboard';
}
