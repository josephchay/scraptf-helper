// The dashboard's view of main's background-service state. Main pushes
// 'service.state' once per change, so a page that loads afterwards (a reload
// after a renderer crash, or a first open from the tray during a crash-loop
// wait) asks for the current state once with 'app.serviceState'.

import type { PushContract } from '../shared/rpc';

export type ServiceStatePush = PushContract['service.state'];

function isServiceStatePush(p: unknown): p is ServiceStatePush {
  return typeof p === 'object' && p !== null && typeof (p as { state?: unknown }).state === 'string';
}

export interface ServiceStateTracker {
  /** A 'service.state' push from main. */
  onPush(p: unknown): void;
  /** The 'app.serviceState' answer asked for on load; a push that arrived meanwhile is newer and wins. */
  onCurrent(p: unknown): void;
}

export function createServiceStateTracker(apply: (s: ServiceStatePush) => void, refreshStatus: () => void): ServiceStateTracker {
  let last: string | null = null;
  let pushed = false;
  const take = (p: ServiceStatePush): void => {
    const prev = last;
    last = p.state;
    apply(p);
    // A (re)started service has fresh status; fetch it once it is ready again.
    if (p.state === 'ready' && prev !== null && prev !== 'ready') refreshStatus();
  };
  return {
    onPush(p) {
      if (!isServiceStatePush(p)) return;
      pushed = true;
      take(p);
    },
    onCurrent(p) {
      if (!pushed && isServiceStatePush(p)) take(p);
    },
  };
}

/** True while the service banner shows (starting, restarting, stopped). */
export function serviceNotReady(s: ServiceStatePush | null): s is ServiceStatePush {
  return s !== null && s.state !== 'ready';
}
