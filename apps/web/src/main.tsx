import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './landing/Landing.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root container');
const Studio = lazy(() => import('./studio/Studio.tsx'));
const Controller = lazy(() => import('./controller/Controller.tsx'));
const Preview = lazy(() => import('./controller/Preview.tsx'));

createRoot(container).render(
  <StrictMode>
    {window.location.pathname === '/studio' ? (
      <Suspense fallback={<p role="status">Opening Cocoon Studio…</p>}>
        <Studio />
      </Suspense>
    ) : window.location.pathname === '/controller' ? (
      <Suspense fallback={<p role="status">Opening controller…</p>}>
        <Controller />
      </Suspense>
    ) : window.location.pathname === '/preview' ? (
      <Suspense fallback={<p role="status">Opening preview…</p>}>
        <Preview />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
