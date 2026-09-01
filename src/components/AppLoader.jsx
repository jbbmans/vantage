import React from 'react';

export default function AppLoader({ compact = false, label = 'Loading Vantage…' }) {
  return (
    <div className={compact ? 'flex items-center gap-3 py-6' : 'flex min-h-screen items-center justify-center bg-ink p-4'} role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="vantage-loader" aria-hidden>
          <span className="vantage-loader__orbit" />
          <img src="/mark.svg" alt="" className="vantage-loader__mark" />
        </div>
        <div>
          <p className="text-sm font-medium text-text">{label}</p>
          {!compact && <p className="mt-1 text-xs text-text-3">Preparing your operational picture</p>}
        </div>
      </div>
    </div>
  );
}
