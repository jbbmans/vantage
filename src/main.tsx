import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, MotionConfig } from 'motion/react';
import App from './App';
import { installMotionPolicy, loadMotionFeatures } from './lib/motion';
import { queryClient } from './lib/queries';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/index.css';
import './styles/brand-2026.css';
import './styles/experience-motion.css';
import './styles/login-premium.css';
import './styles/public-site.css';
import './styles/public-showcase.css';
import './styles/public-site-a11y.css';
// Last, so the premium layer sits over the brand and motion layers. Scoped to the signed-in app.
import './styles/premium.css';

// One reduced-motion setting for every animation library, not just the CSS layer (src/lib/motion.ts).
installMotionPolicy();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary full>
      <QueryClientProvider client={queryClient}>
        <LazyMotion features={loadMotionFeatures} strict>
          <MotionConfig reducedMotion="user">
            <App />
          </MotionConfig>
        </LazyMotion>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) window.dispatchEvent(new CustomEvent('vantage:update-available'));
        });
      });
    }).catch(() => undefined);
  });
}
