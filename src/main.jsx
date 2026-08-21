/**
 * Vantage — performance record system
 * Designed and built by John Bernard Boletz
 *
 * Self-hosted. No third-party services, no telemetry, no vendor backend.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import ErrorBoundary from '@/components/ErrorBoundary';
import '@/styles/index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
