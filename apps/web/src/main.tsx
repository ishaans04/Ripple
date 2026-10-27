import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './landing/Landing.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root container');
const Studio = lazy(() => import('./studio/Studio.tsx'));

createRoot(container).render(
  <StrictMode>
    {window.location.pathname === '/studio' ? (
      <Suspense fallback={<p role="status">Opening Cocoon Studio…</p>}>
        <Studio />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
