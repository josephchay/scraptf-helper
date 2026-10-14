import { useCallback, useSyncExternalStore } from 'react';

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** Splits "#/prices/rules" into ["prices", "rules"]. */
export function parseHash(hash: string): string[] {
  return hash
    .replace(/^#\/?/, '')
    .split('?')[0]!
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function useHashRoute(): { segments: string[]; navigate: (path: string) => void } {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => '');
  const navigate = useCallback((path: string) => {
    const next = `#/${path.replace(/^[#/]+/, '')}`;
    if (window.location.hash !== next) window.location.hash = next;
  }, []);
  return { segments: parseHash(hash), navigate };
}
