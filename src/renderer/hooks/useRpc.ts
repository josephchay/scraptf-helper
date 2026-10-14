import { useCallback, useEffect, useRef, useState } from 'react';
import type { PushContract, PushEvent, RpcMethod, RpcParams, RpcResult } from '../../shared/rpc';
import { call, on } from '../api';
import { errorMessage } from '../format';
import { useDocumentVisible } from './useTimers';

export interface RpcQuery<T> {
  data: T | undefined;
  error: string | null;
  /** True only until the first response; later reloads keep showing old data. */
  loading: boolean;
  reloading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Calls an RPC method and re-runs it when params change (compared by JSON).
 * Responses that arrive out of order are dropped.
 */
export function useRpcQuery<M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
  opts: { enabled?: boolean } = {},
): RpcQuery<RpcResult<M>> {
  const enabled = opts.enabled ?? true;
  const [data, setDataState] = useState<RpcResult<M> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const seq = useRef(0);
  const paramsKey = JSON.stringify(params ?? null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const run = useCallback(async () => {
    const id = ++seq.current;
    setReloading(true);
    try {
      const result = await call(method, paramsRef.current);
      if (id !== seq.current) return;
      setDataState(result);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (id === seq.current) {
        setLoading(false);
        setReloading(false);
      }
    }
    // paramsKey drives re-runs; paramsRef carries the value.
  }, [method, paramsKey]);

  useEffect(() => {
    if (!enabled) return;
    void run();
  }, [run, enabled]);

  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  const setData = useCallback((fn: (prev: RpcResult<M> | undefined) => RpcResult<M> | undefined) => setDataState(fn), []);
  return { data, error, loading: loading && enabled, reloading, reload: run, setData };
}

/** Subscribes to a push event for the lifetime of the component. */
export function usePush<E extends PushEvent>(event: E, fn: (payload: PushContract[E]) => void, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return on(event, (p) => ref.current(p));
  }, [event, enabled]);
}

export interface HiddenPushGate {
  /** A push arrived; true when it should be handled now. */
  push(visible: boolean): boolean;
  /** The window was shown; true once if pushes were held while it was hidden. */
  shown(): boolean;
}

/** While hidden, pushes collapse into one catch-up for when the window is shown again. */
export function createHiddenPushGate(): HiddenPushGate {
  let missed = false;
  return {
    push(visible) {
      if (visible) return true;
      missed = true;
      return false;
    },
    shown() {
      const run = missed;
      missed = false;
      return run;
    },
  };
}

/**
 * usePush for pushes that trigger RPC work (reloads, item.detail). A window closed
 * to the tray, or quick entry hidden with Esc, stays mounted and would otherwise
 * keep doing that work, and fetching, for nobody; it catches up once when shown.
 */
export function useVisiblePush(event: PushEvent, fn: () => void, enabled = true): void {
  const visible = useDocumentVisible();
  const [gate] = useState(createHiddenPushGate);
  const ref = useRef(fn);
  ref.current = fn;
  usePush(
    event,
    () => {
      if (gate.push(document.visibilityState !== 'hidden')) ref.current();
    },
    enabled,
  );
  useEffect(() => {
    if (visible && enabled && gate.shown()) ref.current();
  }, [visible, enabled, gate]);
}

/**
 * Returns a function that runs `fn` at most once per `ms`; calls during the
 * quiet period collapse into one trailing call.
 */
export function useThrottled(fn: () => void, ms: number): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    const now = Date.now();
    const wait = last.current + ms - now;
    if (wait <= 0) {
      last.current = now;
      ref.current();
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      last.current = Date.now();
      ref.current();
    }, wait);
  }, [ms]);
}
