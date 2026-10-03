import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(<App />);

// Offline support / installable app. Only in the production build – the dev server must stay uncached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
