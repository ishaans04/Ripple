import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './landing/Landing.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root container');

createRoot(container).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
