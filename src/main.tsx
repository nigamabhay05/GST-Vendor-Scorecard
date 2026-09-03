import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { App } from './ui/App';

const container = document.getElementById('root');
if (!container) {
  // A missing mount point is a build error, not something to paper over with a retry.
  throw new Error('Mount point #root is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
