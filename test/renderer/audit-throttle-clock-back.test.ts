import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Plain refs and callbacks so the hook runs outside a React render.
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  useRef: <T,>(v: T) => ({ current: v }),
  useCallback: <F,>(f: F) => f,
  useEffect: () => {},
}));

import { useThrottled } from '../../src/renderer/hooks/useRpc';

// Audit rmodelsB-6: a wall clock stepped back must not stall the throttle
// for the size of the jump.
describe('useThrottled with a clock that moves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a clock stepped back delays a call by at most one period', () => {
    let runs = 0;
    const t = useThrottled(() => runs++, 2000);
    t();
    expect(runs).toBe(1);
    vi.setSystemTime(new Date('2026-10-20T11:00:00Z'));
    t();
    vi.advanceTimersByTime(2000);
    expect(runs).toBe(2);
    for (let i = 0; i < 30; i++) {
      t();
      vi.advanceTimersByTime(2000);
    }
    expect(runs).toBeGreaterThanOrEqual(15);
  });

  it('runs the first call now and collapses a burst into one trailing call', () => {
    let runs = 0;
    const t = useThrottled(() => runs++, 2000);
    t();
    t();
    t();
    expect(runs).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(2);
  });

  it('runs at once after a forward clock jump', () => {
    let runs = 0;
    const t = useThrottled(() => runs++, 2000);
    t();
    vi.setSystemTime(new Date('2026-10-20T13:00:00Z'));
    t();
    expect(runs).toBe(2);
  });
});
