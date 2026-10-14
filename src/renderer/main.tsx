// Fast Refresh preamble as a module import: the CSP blocks the inline script
// Vite would otherwise inject. It is an empty module in production builds.
import '@vitejs/plugin-react/preamble';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App';
import { readPref } from './hooks/usePersistentState';

// Apply the last-used appearance before the first paint to avoid a theme flash.
const appearance = readPref<{ theme?: unknown; density?: unknown }>('appearance', {});
const root = document.documentElement;
root.dataset['theme'] = appearance.theme === 'dark' || appearance.theme === 'light' ? appearance.theme : 'system';
root.dataset['density'] = appearance.density === 'compact' ? 'compact' : 'comfortable';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
