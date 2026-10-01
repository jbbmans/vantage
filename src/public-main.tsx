import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/public.css';
import PublicSite from './pages/PublicSite';

// The server sends this page already rendered (scripts/prerender.mjs), so React adopts that markup rather
// than rebuilding it: nothing on screen moves, and the page is interactive as soon as this script runs.
const root = document.getElementById('root')!;
const page = (
  <StrictMode>
    <BrowserRouter>
      <PublicSite />
    </BrowserRouter>
  </StrictMode>
);
if (root.firstElementChild) hydrateRoot(root, page);
else createRoot(root).render(page);
