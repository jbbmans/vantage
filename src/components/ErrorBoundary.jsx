import React from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

/**
 * Without this, any render error white-screens the whole app. Records are safe
 * on the server either way, so the job here is to say so plainly and give a way
 * back in — not to bury the user in an apology.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Local only. Nothing is reported anywhere.
    console.error('Vantage crashed:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-ink p-4">
        <div className="panel w-full max-w-lg rounded p-5">
          <div className="flex items-start gap-2.5">
            <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-redline" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-text">Something in the interface broke</h1>
              <p className="mt-1 text-sm leading-relaxed text-text-2">
                Your records are safe on the server — this is a display fault, not a data fault. Reloading will
                usually clear it.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => window.location.assign('/')}
              className="flex h-8 items-center gap-1.5 rounded border border-rule-strong bg-panel-2 px-3 text-base text-text hover:border-signal"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reload Vantage
            </button>
          </div>


          <details className="mt-4 border-t border-rule pt-3">
            <summary className="cursor-pointer text-xs text-text-3 hover:text-text-2">Technical detail</summary>
            <pre className="fig mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 text-2xs text-text-3">
              {String(this.state.error?.stack || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
