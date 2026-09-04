import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

interface State { error: Error | null }

/** Keeps one broken page from taking the whole app down. Resets when `resetKey` changes (route navigation). */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: string; full?: boolean }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('Vantage page error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className={this.props.full ? 'flex min-h-screen items-center justify-center bg-canvas p-6' : 'page'}>
        <div className="card mx-auto max-w-lg p-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-bad/40 bg-bad/10 text-bad"><AlertTriangle className="h-5 w-5" /></div>
          <h1 className="text-lg font-semibold text-ink">This page hit an error</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">Your records are safe; nothing was changed. Reload the page, or go back to the dashboard.</p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-md border border-line bg-surface-2 p-2 text-left font-mono text-2xs text-ink-3">{message}</pre>
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" />Reload</Button>
            <Button variant="primary" onClick={() => { window.location.assign('/'); }}><Home className="h-4 w-4" />Dashboard</Button>
          </div>
        </div>
      </div>
    );
  }
}
