import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import ConsoleApp from './console/ConsoleApp';
import { queryClient } from './lib/queries';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/index.css';
import './styles/login-premium.css';

// The Unit Manager console is its own document and bundle: none of the application's pages load here, and it works
// online only, with no service worker.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary full>
      <QueryClientProvider client={queryClient}>
        <ConsoleApp />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
