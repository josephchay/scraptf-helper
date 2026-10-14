import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'flipdesk.ui.';

/** Reads a per-viewer UI preference; storage can be missing or blocked. */
export function readPref<T>(key: string, fallback: T, sanitize?: (v: unknown) => T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return sanitize ? sanitize(parsed) : (parsed as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience only.
  }
}

/** useState backed by localStorage for UI conveniences (filters, collapsed groups). */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  sanitize?: (v: unknown) => T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback, sanitize));
  useEffect(() => {
    writePref(key, value);
  }, [key, value]);
  const set = useCallback((next: T | ((prev: T) => T)) => setValue(next), []);
  return [value, set];
}
