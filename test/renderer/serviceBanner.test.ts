import { describe, expect, it, vi } from 'vitest';
import { serviceStatePush, type ServiceHostStatus } from '../../src/main/serviceHost';
import { serviceBannerDetail } from '../../src/renderer/format';
import { createServiceStateTracker, serviceNotReady, type ServiceStatePush } from '../../src/renderer/serviceStateModel';

describe('service banner countdown', () => {
  const base: ServiceHostStatus = { state: 'restarting', pid: null, restarts: 5, lastExitCode: 1, nextRestartAt: null, lastError: null, readyAt: null };

  it('counts down from the single push main sends, instead of freezing at "900 s"', () => {
    const t0 = 1_000_000;
    const push = serviceStatePush({ ...base, nextRestartAt: t0 + 900_000, lastError: 'fatal error: crash' }, t0)!;
    expect(serviceBannerDetail(push, t0)).toBe('Next attempt in 15 min 00 s. fatal error: crash');
    // Same push, later ticks of the banner's clock.
    expect(serviceBannerDetail(push, t0 + 60_000)).toBe('Next attempt in 14 min 00 s. fatal error: crash');
    expect(serviceBannerDetail(push, t0 + 895_500)).toBe('Next attempt in 5 s. fatal error: crash');
    expect(serviceBannerDetail(push, t0 + 900_000)).toBe('Trying again now. fatal error: crash');
  });

  it('shows only the error, or nothing, without a pending attempt', () => {
    expect(serviceBannerDetail({ state: 'stopped', detail: 'gave up', nextAttemptAt: null }, 0)).toBe('gave up');
    expect(serviceBannerDetail({ state: 'restarting', detail: null, nextAttemptAt: null }, 0)).toBeNull();
    expect(serviceBannerDetail({ state: 'starting', detail: null, nextAttemptAt: 5_000 }, 0)).toBeNull();
  });
});

describe('a page that loads after the push (reload after a renderer crash, late first open)', () => {
  const base: ServiceHostStatus = { state: 'restarting', pid: null, restarts: 5, lastExitCode: 1, nextRestartAt: null, lastError: null, readyAt: null };
  const t0 = 1_000_000;
  // What main answers to 'app.serviceState' (main.ts: serviceStatePush(host.status(), Date.now())).
  const current = serviceStatePush({ ...base, nextRestartAt: t0 + 900_000, lastError: 'fatal error: crash' }, t0);
  const track = () => {
    const applied: ServiceStatePush[] = [];
    const refreshStatus = vi.fn();
    return { applied, refreshStatus, tracker: createServiceStateTracker((s) => applied.push(s), refreshStatus) };
  };

  it('shows the restart banner with its countdown, and fetches status once the service is ready', () => {
    const t = track();
    t.tracker.onCurrent(current);
    const shown = t.applied.at(-1) ?? null;
    expect(serviceNotReady(shown)).toBe(true);
    expect(serviceBannerDetail(shown!, t0 + 60_000)).toBe('Next attempt in 14 min 00 s. fatal error: crash');
    t.tracker.onPush({ state: 'starting', detail: null, nextAttemptAt: null });
    expect(t.refreshStatus).not.toHaveBeenCalled();
    t.tracker.onPush({ state: 'ready', detail: null, nextAttemptAt: null });
    expect(t.refreshStatus).toHaveBeenCalledTimes(1);
    expect(serviceNotReady(t.applied.at(-1)!)).toBe(false);
  });

  it('lets a push that arrived first win over the slower answer', () => {
    const t = track();
    t.tracker.onPush({ state: 'ready', detail: null, nextAttemptAt: null });
    t.tracker.onCurrent(current);
    expect(t.applied.map((s) => s.state)).toEqual(['ready']);
  });

  it('ignores no answer (idle, stopping, or an RPC that failed)', () => {
    const t = track();
    t.tracker.onCurrent(null);
    t.tracker.onCurrent(undefined);
    expect(t.applied).toEqual([]);
    expect(serviceNotReady(null)).toBe(false);
    // The first state seen is ready: status.get is already on its way, nothing to refresh.
    t.tracker.onPush({ state: 'ready', detail: null, nextAttemptAt: null });
    expect(t.refreshStatus).not.toHaveBeenCalled();
  });
});
