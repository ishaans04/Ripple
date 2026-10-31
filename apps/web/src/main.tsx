import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/soft.css';
import '@fontsource-variable/fraunces/soft-italic.css';
import '@fontsource-variable/bricolage-grotesque/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import { Landing } from './landing/Landing.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root container');
// Scroll reveals hide content only once script is running to reveal it again.
document.documentElement.classList.add('js');
const Studio = lazy(() => import('./studio/Studio.tsx'));
const Controller = lazy(() => import('./controller/Controller.tsx'));
const Preview = lazy(() => import('./controller/Preview.tsx'));
const Overlay = lazy(() => import('./overlay/Overlay.tsx'));
const Lineage = lazy(() => import('./lineage/Lineage.tsx'));
const Bridge = lazy(() => import('./bridge/Bridge.tsx'));
const Sandbox = lazy(() => import('./sandbox/Sandbox.tsx'));
const Privacy = lazy(() => import('./privacy/Privacy.tsx'));
if (window.location.pathname === '/overlay' || window.location.pathname === '/bridge')
  document.documentElement.dataset.surface = 'overlay';

/** A quiet ripple while a page's code loads; stream surfaces keep plain text only. */
function Opening({ label, plain = false }: { label: string; plain?: boolean }) {
  return plain ? (
    <p role="status">{label}</p>
  ) : (
    <div className="route-loader">
      <span className="route-loader-ring" aria-hidden="true" />
      <p role="status">{label}</p>
    </div>
  );
}

createRoot(container).render(
  <StrictMode>
    {window.location.pathname === '/privacy' ? (
      <Suspense fallback={<Opening label="Opening privacy policy…" />}>
        <Privacy />
      </Suspense>
    ) : window.location.pathname === '/sandbox' ? (
      <Suspense fallback={<Opening label="Opening sandbox…" />}>
        <Sandbox />
      </Suspense>
    ) : window.location.pathname === '/studio' ? (
      <Suspense fallback={<Opening label="Opening Cocoon Studio…" />}>
        <Studio />
      </Suspense>
    ) : window.location.pathname === '/controller' ? (
      <Suspense fallback={<Opening label="Opening controller…" />}>
        <Controller />
      </Suspense>
    ) : window.location.pathname === '/preview' ? (
      <Suspense fallback={<Opening label="Opening preview…" />}>
        <Preview />
      </Suspense>
    ) : window.location.pathname === '/lineage' ? (
      <Suspense fallback={<Opening label="Opening lineages…" />}>
        <Lineage />
      </Suspense>
    ) : window.location.pathname === '/bridge' ? (
      <Suspense fallback={<Opening label="Starting the studio bridge…" plain />}>
        <Bridge />
      </Suspense>
    ) : window.location.pathname === '/overlay' ? (
      <Suspense fallback={<Opening label="Opening overlay…" plain />}>
        <Overlay />
      </Suspense>
    ) : (
      <Landing />
    )}
  </StrictMode>,
);
