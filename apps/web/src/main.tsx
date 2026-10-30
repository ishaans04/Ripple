import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './landing/Landing.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root container');
const Studio = lazy(() => import('./studio/Studio.tsx'));
const Controller = lazy(() => import('./controller/Controller.tsx'));
const Preview = lazy(() => import('./controller/Preview.tsx'));
const Overlay = lazy(() => import('./overlay/Overlay.tsx'));
const Lineage = lazy(() => import('./lineage/Lineage.tsx'));
const Bridge = lazy(() => import('./bridge/Bridge.tsx'));
const Sandbox = lazy(() => import('./sandbox/Sandbox.tsx'));
if (window.location.pathname === '/overlay' || window.location.pathname === '/bridge')
  document.documentElement.dataset.surface = 'overlay';

createRoot(container).render(
  <StrictMode>
    {window.location.pathname === '/sandbox' ? (
      <Suspense fallback={<p role="status">Opening sandbox…</p>}>
        <Sandbox />
      </Suspense>
    ) : window.location.pathname === '/studio' ? (
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
    ) : window.location.pathname === '/lineage' ? (
      <Suspense fallback={<p role="status">Opening lineages…</p>}>
        <Lineage />
      </Suspense>
    ) : window.location.pathname === '/bridge' ? (
      <Suspense fallback={<p role="status">Starting the studio bridge…</p>}>
        <Bridge />
      </Suspense>
    ) : window.location.pathname === '/overlay' ? (
      <Suspense fallback={<p role="status">Opening overlay…</p>}>
        <Overlay />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
